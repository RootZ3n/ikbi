/**
 * A protocol-faithful local OpenAI-compatible provider (NOT a test file).
 *
 * It exists so the real V2 production path — CLI → policy → resolver → context →
 * InvocationAuthority → the real v1 HTTP transport → a real socket → a normalized
 * response → lifecycle evidence → receipt — can be proven end to end without spending
 * money or depending on the internet.
 *
 * It speaks the wire protocol rather than pretending to: a real HTTP server, a real
 * `POST /chat/completions`, a real JSON body with `model`, `choices`, `finish_reason`
 * and `usage`. It records what it was actually sent, so a test can assert the exact wire
 * model id that left the process rather than the one the CLI claims it used.
 *
 * WHY IT RUNS OUT OF PROCESS: the subprocess suites drive the CLI with `spawnSync`,
 * which blocks the event loop. A server in the same process could never accept the
 * connection, so every run would sit until its timeout. The server therefore runs in its
 * own `node` process and the test reads what it received over a small admin endpoint —
 * which also makes it a more honest stand-in for a real remote provider.
 *
 * NOTE ON REACHING IT: ikbi's egress floor denies loopback by default. A test must opt in
 * explicitly via `IKBI_EGRESS_ALLOWLIST` + `IKBI_EGRESS_ALLOW_LOCAL`, which is itself
 * worth proving — the SSRF guard is not bypassed for convenience.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** What the server actually received. Authorization is recorded as PRESENCE, never value. */
export interface RecordedProviderRequest {
  readonly method: string;
  readonly path: string;
  /** The `model` field on the request body — the exact wire id that left the process. */
  readonly wireModelId: string | undefined;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly maxTokens: number | undefined;
  /** Names of the tools the client offered on this request. */
  readonly toolNames: readonly string[];
  /** True when an auth header was present. The VALUE is deliberately never retained. */
  readonly hadAuthorization: boolean;
}

/**
 * ONE SCRIPTED TURN — what the provider answers on the Nth request.
 *
 * This is how a multi-turn tool loop is proven without a real model. It is protocol
 * faithful in the way that matters: the server emits a real OpenAI `tool_calls` block,
 * the loop executes it for real, and the result travels back as a real `tool` message.
 *
 * `observationFrom` is the important field. A real model must READ a file, receive an
 * observationId, and quote it back on its next call — so a script that hard-coded an id
 * would prove nothing. Instead the server extracts the id from the LAST tool result in
 * the conversation it was just sent, which means the id genuinely round-trips over the
 * wire exactly as it would for a model.
 */
export interface ScriptedTurn {
  /** Assistant text for this turn. */
  readonly content?: string;
  /** Tool calls to emit. Omit for a plain stop. */
  readonly toolCalls?: readonly {
    readonly name: string;
    /** Literal arguments. Merged with any substitution below. */
    readonly args?: Readonly<Record<string, unknown>>;
    /**
     * Fill `observationId` from an observation the conversation reports.
     * `"last"` uses the newest, `"first"` the oldest (how a STALE one is presented), and
     * a path string uses the newest read of THAT path.
     */
    readonly observationFrom?: string;
  }[];
}

export interface FakeProviderOptions {
  /**
   * Answers, one per request in order. When the script runs out, the server replies with
   * a plain stop — which the builder correctly treats as "stopped without finishing".
   */
  readonly script?: readonly ScriptedTurn[];
  /**
   * What the response reports as having served the request.
   *   a string → that id
   *   "echo"   → whatever the request asked for (the normal, matching case; the default)
   *   null     → omit `model` entirely (the NOT_REPORTED case)
   */
  readonly servedModelId?: string | "echo" | null;
  /** Non-2xx status, to exercise a rejection/failure path. */
  readonly status?: number;
  /** Delay before responding, to exercise a client timeout. */
  readonly delayMs?: number;
  /** Replace the whole response body — used to exercise a malformed response. */
  readonly bodyOverride?: unknown;
  readonly content?: string;
}

export interface FakeProviderServer {
  /** Base URL for a provider roster entry (already includes `/v1`). */
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
  /** Everything the server received, in order. */
  received(): Promise<readonly RecordedProviderRequest[]>;
  close(): Promise<void>;
}

/**
 * The server, as source for a child `node -e`. Self-contained on purpose: it must run
 * identically whether the suite is executed from `src` under tsx or from built `dist`.
 */
const SERVER_SOURCE = String.raw`
const http = require("node:http");
const options = JSON.parse(process.env.FAKE_PROVIDER_OPTIONS || "{}");
const requests = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (req.url === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requests));
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    requests.push({
      method: req.method || "",
      path: req.url || "",
      wireModelId: typeof parsed.model === "string" ? parsed.model : undefined,
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.map((m) => ({ role: typeof m.role === "string" ? m.role : "", content: typeof m.content === "string" ? m.content : "" }))
        : [],
      maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : undefined,
      toolNames: Array.isArray(parsed.tools) ? parsed.tools.map((t) => (t && t.function && t.function.name) || "").filter(Boolean) : [],
      hadAuthorization: req.headers.authorization !== undefined || req.headers["x-api-key"] !== undefined,
    });
    if (options.delayMs > 0) await new Promise((r) => setTimeout(r, options.delayMs));
    const status = options.status || 200;
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fake provider returned " + status, type: "test_error" } }));
      return;
    }
    if (options.bodyOverride !== undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.bodyOverride));
      return;
    }
    // SCRIPTED MULTI-TURN. The Nth request gets the Nth scripted turn.
    //
    // THE DEFAULT is a builder that immediately declares itself finished, having done
    // nothing. Suites about configuration, resolution, context, retrieval or the workspace
    // want a run that REACHES its stop point without the model doing any work - and a fake
    // that merely stopped talking would (correctly) exhaust the builder turn budget and
    // fail the run for a reason unrelated to what they are testing. Suites that care about
    // the builder pass their own script; transport-failure suites set a status or a body
    // override and never reach this line.
    // The default answer is STATELESS on purpose: these suites share one server across
    // many runs, so an indexed script would answer only the first run and leave every
    // later builder talking to a model that had run out of things to say.
    const alwaysFinish =
      !Array.isArray(options.script) && options.bodyOverride === undefined && !options.content
        ? { toolCalls: [{ name: "finish_candidate", args: { summary: "no work was requested of this fake model", believesComplete: true } }] }
        : null;
    const script = Array.isArray(options.script) ? options.script : alwaysFinish ? [] : null;
    if (script) {
      const turn = alwaysFinish || script[requests.length - 1];
      const requestedModel = typeof parsed.model === "string" ? parsed.model : "";
      const servedId = options.servedModelId === undefined || options.servedModelId === "echo" ? requestedModel : options.servedModelId;
      const message = { role: "assistant", content: (turn && turn.content) || "" };
      let finish = "stop";
      if (turn && Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
        finish = "tool_calls";
        message.tool_calls = turn.toolCalls.map((spec, i) => {
          const args = Object.assign({}, spec.args || {});
          if (spec.observationFrom) {
            // Pull the id out of the CONVERSATION the client just sent us, exactly as a
            // model would have to. Tool results render "observationId: <id>" on its own
            // line, preceded by "read_file: OBSERVED <path>".
            const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
            let found = "";
            for (const m of msgs) {
              if (m.role !== "tool" || typeof m.content !== "string") continue;
              const idMatch = /observationId: (\S+)/.exec(m.content);
              if (!idMatch) continue;
              // "first" deliberately keeps the OLDEST — the way to present an observation
              // that later writes have made stale.
              if (spec.observationFrom === "first") { if (!found) found = idMatch[1]; continue; }
              if (spec.observationFrom === "last") { found = idMatch[1]; continue; }
              const pathMatch = /read_file: OBSERVED (\S+)/.exec(m.content);
              if (pathMatch && pathMatch[1] === spec.observationFrom) found = idMatch[1];
            }
            args.observationId = found;
          }
          return { id: "call_" + requests.length + "_" + i, type: "function", function: { name: spec.name, arguments: JSON.stringify(args) } };
        });
      }
      const scripted = {
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        choices: [{ index: 0, message: message, finish_reason: finish }],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      };
      if (servedId !== null) scripted.model = servedId;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(scripted));
      return;
    }

    const requested = typeof parsed.model === "string" ? parsed.model : "";
    const served = options.servedModelId === undefined || options.servedModelId === "echo" ? requested : options.servedModelId;
    const body = {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 0,
      choices: [{ index: 0, message: { role: "assistant", content: options.content || "Acknowledged: task and context received." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
    };
    if (served !== null) body.model = served;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write("PORT=" + server.address().port + "\n"); });
`;

/** Start the server in its own process on an ephemeral loopback port. */
export async function startFakeOpenAIProvider(options: FakeProviderOptions = {}): Promise<FakeProviderServer> {
  const child: ChildProcess = spawn(process.execPath, ["-e", SERVER_SOURCE], {
    env: { ...process.env, FAKE_PROVIDER_OPTIONS: JSON.stringify(options) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the fake provider did not report a port")), 10_000);
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /PORT=(\d+)/.exec(buffer);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the fake provider exited early (${String(code)})`)));
  });
  child.unref();

  const host = "127.0.0.1";
  return {
    baseUrl: `http://${host}:${port}/v1`,
    host,
    port,
    async received(): Promise<readonly RecordedProviderRequest[]> {
      const res = await fetch(`http://${host}:${port}/__requests`);
      return (await res.json()) as RecordedProviderRequest[];
    },
    close: async () => {
      child.kill("SIGKILL");
    },
  };
}

/** The environment a subprocess needs to reach a loopback provider through the egress floor. */
export function loopbackEgressEnv(server: FakeProviderServer): Record<string, string> {
  return {
    // The SSRF floor denies loopback unless the operator opts in for an exact host:port.
    IKBI_EGRESS_ALLOWLIST: server.host,
    IKBI_EGRESS_ALLOW_LOCAL: `${server.host}:${server.port}`,
  };
}
