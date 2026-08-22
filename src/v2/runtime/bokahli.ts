/**
 * ADAPTER — Bokahli, a LOCAL attesting inference deployment, at the v2 provider seam.
 *
 * WHERE THIS SITS. v2 does not use v1's `ProviderInvoker`: `createInvocationTransport` looks one
 * provider up by id and calls `provider.invoke(...)` exactly once. So Bokahli is implemented as a
 * plain `ModelProvider` and nothing more. It performs ONE bounded fetch per invocation and has no
 * route list, no fallback, no retry and no chain-termination hook — there is no chain here to
 * terminate, which is why none of that machinery is carried over.
 *
 * WHAT MAKES BOKAHLI DIFFERENT FROM A REMOTE API. Every other provider is a vendor endpoint whose
 * only provenance is the model NAME it chooses to report. Bokahli serves one artifact at a time,
 * verifies which one is loaded, and says so with a content digest. Two facts therefore travel
 * separately and must never be merged:
 *
 *   servedModelId — what the runtime CLAIMS it served. A string. Available from any provider.
 *   localBinding  — what the deployment ATTESTS, with the artifact digest, the attestation
 *                   result and the qualification state. A claim somebody can check.
 *
 * QUALIFICATION IS NOT OPTIONAL DECORATION. Every artifact on the current deployment reports
 * `INSTALLED_UNQUALIFIED` with authority `none`: Bokahli makes no claim that any of them is fit
 * for any task. Nothing here may default an absent qualification, attestation or digest to a
 * favorable value — an unknown state is recorded as unknown, which is a fact, where a default
 * would be a claim nobody made.
 *
 * A REFUSAL IS AN ANSWER, NOT A FAILURE TO PARSE. When Bokahli declines — nothing installed is
 * qualified, the resident model does not fit, the runtime is unhealthy — it says so in a typed
 * body. That is never turned into model prose, and never into an empty success.
 *
 * AUTHORITY. Bokahli supplies inference. It receives no tool, mutation, verification, publication
 * or promotion authority, and its output re-enters ikbi through the same untrusted boundary as
 * any other model's. Text that looks like a tool call is inert until ikbi's governed layer
 * interprets and authorizes it.
 */

import { lstatSync, readFileSync } from "node:fs";

import { ProviderError } from "../../core/provider/contract.js";
import type {
  FinishReason,
  ModelProvider,
  ProviderInvocation,
  ProviderPreflightInfo,
  ProviderResult,
  TokenUsage,
  ToolCall,
} from "../../core/provider/contract.js";

export const BOKAHLI_PROVIDER_ID = "bokahli";

/** Loopback by default; a tailnet address is valid for a remote Mushin. */
export const BOKAHLI_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

/** Responses larger than this are refused unread. A local appliance has no reason to exceed it. */
export const BOKAHLI_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * The typed outcomes Bokahli reports. Anything else is unknown, and unknown fails closed —
 * a new outcome the deployment starts returning must be handled deliberately, never guessed at.
 */
export const BOKAHLI_OUTCOMES = ["ROUTED", "ESCALATE", "REFUSED", "CAPACITY_UNAVAILABLE"] as const;
export type BokahliOutcome = (typeof BOKAHLI_OUTCOMES)[number];

/**
 * Escalation reasons from `bokahli.client/1`.
 *
 * Pinned as DATA rather than imported: ikbi must not take a build dependency on the Bokahli
 * repository to speak to it over HTTP. That makes this a hand-maintained copy of a list that
 * lives elsewhere, which is exactly why the live suite checks it against a real deployment
 * instead of trusting it.
 */
export const BOKAHLI_ESCALATE_REASONS = [
  "NO_LOCAL_CANDIDATES",
  "NO_QUALIFIED_LOCAL_ROUTE",
  "REQUIREMENTS_UNMET",
  "CONTEXT_EXCEEDS_LOCAL_CAPABILITY",
  "CAPABILITY_UNSUPPORTED",
  "MODEL_NOT_QUALIFIED_FOR_TASK",
  "LOCAL_MODEL_SWAP_REQUIRED",
  "RUNTIME_UNHEALTHY",
] as const;
export type BokahliEscalateReason = (typeof BOKAHLI_ESCALATE_REASONS)[number];

/** Reasons that belong to CAPACITY_UNAVAILABLE rather than to a routing decision. */
export const BOKAHLI_CAPACITY_REASONS = ["QUEUE_FULL", "CONCURRENCY_LIMIT", "RUNTIME_UNHEALTHY"] as const;

/**
 * Which outcomes each reason may legally accompany.
 *
 * A reason arriving under the wrong outcome is a PROTOCOL disagreement, not a routing decision,
 * and is refused. Without this, a deployment (or something impersonating one) could pair a
 * benign-sounding outcome with a reason that means something else entirely and have the pairing
 * accepted because each half looked valid on its own.
 */
const REASON_OUTCOMES: Readonly<Record<string, readonly BokahliOutcome[]>> = {
  NO_LOCAL_CANDIDATES: ["ESCALATE", "REFUSED"],
  NO_QUALIFIED_LOCAL_ROUTE: ["ESCALATE", "REFUSED"],
  REQUIREMENTS_UNMET: ["ESCALATE", "REFUSED"],
  CONTEXT_EXCEEDS_LOCAL_CAPABILITY: ["ESCALATE", "REFUSED"],
  CAPABILITY_UNSUPPORTED: ["ESCALATE", "REFUSED"],
  MODEL_NOT_QUALIFIED_FOR_TASK: ["ESCALATE", "REFUSED"],
  LOCAL_MODEL_SWAP_REQUIRED: ["ESCALATE"],
  RUNTIME_UNHEALTHY: ["ESCALATE", "CAPACITY_UNAVAILABLE"],
  QUEUE_FULL: ["CAPACITY_UNAVAILABLE"],
  CONCURRENCY_LIMIT: ["CAPACITY_UNAVAILABLE"],
};

/**
 * A typed decision by the local deployment, surfaced as a provider error so it cannot be mistaken
 * for content.
 *
 * `retriable` is true ONLY for conditions that are genuinely transient — an unhealthy runtime, a
 * full queue. A refusal about what is installed or qualified is a statement about how the
 * deployment is set up; retrying it changes nothing and merely spends time pretending otherwise.
 */
export class BokahliRefusal extends ProviderError {
  readonly outcome: BokahliOutcome;
  readonly reason: string;
  readonly detail: string;
  /** Artifacts that would satisfy the request, when the deployment offered any. */
  readonly swapCandidates: readonly { readonly modelId: string; readonly coldLoadSeconds: number | null }[];
  /** Identity the deployment attested alongside the refusal, when it attested one. */
  readonly localBinding?: BokahliLocalBinding;

  constructor(opts: {
    outcome: BokahliOutcome;
    reason: string;
    detail: string;
    status?: number;
    swapCandidates?: readonly { readonly modelId: string; readonly coldLoadSeconds: number | null }[];
    localBinding?: BokahliLocalBinding;
  }) {
    const transient = opts.reason === "RUNTIME_UNHEALTHY" || opts.outcome === "CAPACITY_UNAVAILABLE";
    super(`bokahli ${opts.outcome}: ${opts.reason} — ${opts.detail}`, {
      kind: transient ? "http" : "config",
      provider: BOKAHLI_PROVIDER_ID,
      retriable: transient,
      ...(opts.status !== undefined ? { status: opts.status } : {}),
    });
    this.name = "BokahliRefusal";
    this.outcome = opts.outcome;
    this.reason = opts.reason;
    this.detail = opts.detail;
    this.swapCandidates = opts.swapCandidates ?? [];
    if (opts.localBinding !== undefined) this.localBinding = opts.localBinding;
  }
}

/** A protocol violation: the deployment said something this adapter will not guess the meaning of. */
export class BokahliProtocolError extends ProviderError {
  constructor(message: string, status?: number) {
    super(`bokahli protocol: ${message}`, {
      kind: "bad_response",
      provider: BOKAHLI_PROVIDER_ID,
      retriable: false,
      ...(status !== undefined ? { status } : {}),
    });
    this.name = "BokahliProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/**
 * Read the API token from a mode-0600 REGULAR file.
 *
 * CHECKED BEFORE THE READ, and with `lstat` rather than `stat`. A warning issued after the fact
 * is a warning about a secret already loaded into a process that will go on to use it; and
 * following a symlink would mean the thing whose permissions were checked is not the thing that
 * was read. A symlink is refused outright rather than resolved: the operator asked for a specific
 * file, and silently reading a different one is how a credential ends up somewhere unexpected.
 *
 * The token is returned to the caller and held only in the provider closure. It is never placed
 * in argv, an environment variable, a log line, a receipt, an error message or model context.
 */
export function readBokahliCredential(path: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (cause) {
    throw new ProviderError(`bokahli credential file is not readable at ${path}`, {
      kind: "auth", provider: BOKAHLI_PROVIDER_ID, retriable: false, cause,
    });
  }
  if (st.isSymbolicLink()) {
    throw new ProviderError(
      `bokahli credential file ${path} is a symlink; refusing to follow it — the file whose ` +
        `permissions were checked must be the file that is read`,
      { kind: "auth", provider: BOKAHLI_PROVIDER_ID, retriable: false },
    );
  }
  if (!st.isFile()) {
    throw new ProviderError(`bokahli credential path ${path} is not a regular file`, {
      kind: "auth", provider: BOKAHLI_PROVIDER_ID, retriable: false,
    });
  }
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ProviderError(
      `bokahli credential file ${path} has mode ${mode.toString(8).padStart(4, "0")}; it must not be ` +
        `readable by group or others (chmod 600 ${path})`,
      { kind: "auth", provider: BOKAHLI_PROVIDER_ID, retriable: false },
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length === 0) {
    throw new ProviderError(`bokahli credential file ${path} is empty`, {
      kind: "auth", provider: BOKAHLI_PROVIDER_ID, retriable: false,
    });
  }
  return token;
}

// ---------------------------------------------------------------------------
// Attested identity
// ---------------------------------------------------------------------------

/**
 * What the local deployment ATTESTS about the artifact that served a request.
 *
 * Owned by v2 rather than added to the v1 provider contract: v2 is the only consumer, and the
 * frozen core does not need a concept it never reads.
 *
 * This is the half of provenance a remote API cannot supply. `servedModelId` is a name the
 * runtime chose to report; everything here is a claim that can be checked against a catalog.
 * Nothing in it is defaulted to a favorable value — see `readLocalBinding`.
 */
export interface BokahliLocalBinding {
  readonly outcome: string;
  /** Catalog identity of the artifact that served this request. */
  readonly modelId: string;
  /** Content digest of that artifact — the fact the model name is not. */
  readonly artifactDigest: string;
  readonly quantization?: string;
  /** Context actually served, which is not the artifact's trained context. */
  readonly servedContextTokens?: number;
  readonly runtimeBuild?: string;
  /** Identifies the backend process; changes across a restart. */
  readonly backendInstanceId?: string;
  /** False means the deployment could not confirm what it was serving. NEVER defaulted to true. */
  readonly attested: boolean;
  readonly attestationMethod?: string;
  /** `INSTALLED_UNQUALIFIED` on the current deployment. `UNKNOWN` when absent — never invented. */
  readonly qualificationStatus: string;
  /** `none` unless an operator trust anchor accepted evidence. */
  readonly qualificationAuthority: string;
  /** The deployment's own correlation id, for cross-referencing its journal. */
  readonly requestId?: string;
}

/** A `ProviderResult` carrying the attested identity alongside the claimed one. */
export interface BokahliProviderResult extends ProviderResult {
  /**
   * What the deployment ATTESTED. Bokahli calls this `bokahli.servedIdentity` on the wire; the
   * field is named for the CORE contract it satisfies, so the invocation record can carry it
   * without core learning which provider produced it.
   */
  readonly attestedIdentity?: BokahliLocalBinding;
  /** How this result must be treated downstream. Present for supervised-local runs. */
  readonly supervision?: SupervisedLocalStamp;
}

/**
 * The structural mark a supervised-local result carries.
 *
 * A result produced by an unqualified local artifact is USEFUL — an operator can read it, judge
 * it, and act on it. What it is not is trustworthy enough to act on unattended. Recording that as
 * data, on the result, is what keeps the distinction from depending on somebody remembering it.
 */
export interface SupervisedLocalStamp {
  readonly executionClass: "local";
  /** True only when qualification is genuinely trusted. Absent evidence is never "qualified". */
  readonly qualified: boolean;
  readonly humanReviewRequired: true;
  readonly autonomousPromotionAllowed: false;
  /** Why supervision applies, for the receipt and for the operator reading it later. */
  readonly reason: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const put = <T,>(k: string, v: T | undefined): Record<string, T> => (v === undefined ? {} : ({ [k]: v } as Record<string, T>));

/**
 * Read the attested identity from a Bokahli response, or `undefined` when it attested none.
 *
 * ABSENCE IS REPORTED AS ABSENCE. `attested` is true only when the deployment said `true`;
 * `qualificationStatus` falls back to `"UNKNOWN"` and authority to `"unknown"` — both facts —
 * rather than to `INSTALLED_UNQUALIFIED`, which would be a claim about a deployment that made
 * none. A binding with no `modelId` or no digest is not a binding and is not returned.
 */
export function readLocalBinding(body: unknown): BokahliLocalBinding | undefined {
  const root = obj(body);
  const bok = root === undefined ? undefined : obj(root["bokahli"]);
  const served = bok === undefined ? undefined : obj(bok["servedIdentity"]);
  if (served === undefined) return undefined;

  const modelId = str(served["modelId"]);
  const digest = str(served["artifactDigest"]) ?? str(served["digest"]);
  if (modelId === undefined || digest === undefined) return undefined;

  const qual = obj(served["qualification"]) ?? {};
  const runtime = obj(served["runtime"]) ?? {};
  return {
    outcome: str(served["outcome"]) ?? "ROUTED",
    modelId,
    artifactDigest: digest,
    ...put("quantization", str(served["quantization"])),
    ...put("servedContextTokens", num(served["servedContextTokens"])),
    ...put("runtimeBuild", str(runtime["build"])),
    ...put("backendInstanceId", str(served["backendInstanceId"])),
    attested: served["attested"] === true,
    ...put("attestationMethod", str(served["attestationMethod"])),
    qualificationStatus: str(qual["status"]) ?? "UNKNOWN",
    qualificationAuthority: str(qual["authority"]) ?? "unknown",
    ...put("requestId", str(root?.["requestId"]) ?? str(root?.["id"])),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/** What a response body turned out to be. */
export type BokahliClassification =
  | { readonly kind: "routed" }
  | { readonly kind: "refusal"; readonly refusal: BokahliRefusal };

/**
 * Classify a response body, strictly.
 *
 * THE FAIL-CLOSED RULE. Every path that cannot be understood raises `BokahliProtocolError`
 * instead of falling through to "probably a completion". An unrecognized outcome, a reason this
 * adapter does not know, or a reason paired with an outcome it may not legally accompany are all
 * refusals to guess — because the guess that costs something is the one that reads a decline as
 * content and hands it to a builder as if a model had spoken.
 */
export function classifyResponse(body: unknown, status: number): BokahliClassification {
  const root = obj(body);
  if (root === undefined) throw new BokahliProtocolError("response body is not a JSON object", status);

  const binding = readLocalBinding(body);
  const route = obj(root["route"]);
  const errorObj = obj(root["error"]);

  // Native dialect: an explicit outcome.
  const rawOutcome = str(root["outcome"]);
  // OpenAI dialect: a typed error code standing in for the outcome.
  const rawCode = errorObj === undefined ? undefined : str(errorObj["code"]);

  if (rawOutcome === undefined && rawCode === undefined) {
    // An ordinary completion. It must actually look like one.
    if (!Array.isArray(root["choices"])) {
      throw new BokahliProtocolError("response carries neither an outcome, a typed error, nor choices", status);
    }
    if (status !== 200) {
      throw new BokahliProtocolError(`HTTP ${status} carried a completion body — status and body disagree`, status);
    }
    return { kind: "routed" };
  }

  const outcome = rawOutcome ?? inferOutcomeFromCode(rawCode as string, status);
  if (!(BOKAHLI_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new BokahliProtocolError(`unknown outcome ${JSON.stringify(outcome)}`, status);
  }
  const typed = outcome as BokahliOutcome;

  if (typed === "ROUTED") {
    if (!Array.isArray(root["choices"])) {
      throw new BokahliProtocolError("outcome ROUTED without a choices array — status and body disagree", status);
    }
    if (status !== 200) {
      throw new BokahliProtocolError(`outcome ROUTED under HTTP ${status} — status and body disagree`, status);
    }
    return { kind: "routed" };
  }

  // A non-ROUTED outcome under HTTP 200 is legal (the deployment answered the question it was
  // asked), but a SUCCESS body must not accompany it — that is a contradiction, not a decision.
  if (Array.isArray(root["choices"]) && (root["choices"] as unknown[]).length > 0) {
    throw new BokahliProtocolError(`outcome ${typed} arrived with completion choices — status and body disagree`, status);
  }

  const reason = str(route?.["reason"]) ?? rawCode ?? str(errorObj?.["code"]);
  if (reason === undefined) throw new BokahliProtocolError(`outcome ${typed} carries no reason`, status);
  const allowed = REASON_OUTCOMES[reason];
  if (allowed === undefined) throw new BokahliProtocolError(`unknown reason ${JSON.stringify(reason)}`, status);
  if (!allowed.includes(typed)) {
    throw new BokahliProtocolError(`reason ${reason} may not accompany outcome ${typed}`, status);
  }

  const swap = obj(route?.["swap"]);
  const candidates = Array.isArray(swap?.["candidates"])
    ? (swap["candidates"] as unknown[]).map((c) => {
        const e = obj(c) ?? {};
        return { modelId: str(e["modelId"]) ?? "", coldLoadSeconds: num(e["coldLoadSeconds"]) ?? null };
      })
    : [];

  return {
    kind: "refusal",
    refusal: new BokahliRefusal({
      outcome: typed,
      reason,
      detail: str(route?.["detail"]) ?? str(errorObj?.["message"]) ?? typed,
      status,
      swapCandidates: candidates,
      ...(binding !== undefined ? { localBinding: binding } : {}),
    }),
  };
}

/** An OpenAI-dialect error code implies its outcome; anything unmapped is unknown and fails closed. */
function inferOutcomeFromCode(code: string, status: number): string {
  if ((BOKAHLI_CAPACITY_REASONS as readonly string[]).includes(code) && code !== "RUNTIME_UNHEALTHY") return "CAPACITY_UNAVAILABLE";
  if (code === "RUNTIME_UNHEALTHY") return status === 503 ? "CAPACITY_UNAVAILABLE" : "ESCALATE";
  if ((BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(code)) return "ESCALATE";
  throw new BokahliProtocolError(`unknown error code ${JSON.stringify(code)}`, status);
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** How the deployment should choose an artifact. */
export type BokahliRouteMode = "AUTO" | "PROFILE" | "EXACT";

export interface BokahliProviderConfig {
  /** Endpoint base, including the `/v1` suffix. */
  readonly baseUrl?: string;
  /** Absolute path to the mode-0600 regular file holding the token. */
  readonly credentialFile: string;
  readonly routeMode: BokahliRouteMode;
  /** Required for EXACT (an artifact id) and PROFILE (a profile name); unused by AUTO. */
  readonly target?: string;
  /** What the request is for. The deployment qualifies artifacts per task class, not globally. */
  readonly taskClass?: string;
  /**
   * Demand a QUALIFIED artifact. When set, an unqualified answer is refused even if the
   * deployment served one — and this NEVER silently becomes a supervised-local run.
   */
  readonly requireQualified: boolean;
  /**
   * Opt IN to accepting an installed-but-unqualified artifact under supervision. Absent or false
   * means an unqualified answer is refused. This is never inferred from the endpoint being local:
   * "local" describes where inference happened, not whether a human agreed to review it.
   */
  readonly supervisedLocal?: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly maxResponseBytes?: number;
}

/**
 * Build the native v2 Bokahli provider.
 *
 * The credential is read ONCE, here, so a misconfigured deployment fails while somebody is
 * looking at it rather than at first use. It lives in this closure and nowhere else.
 */
export function createBokahliProvider(cfg: BokahliProviderConfig): ModelProvider {
  if (cfg.requireQualified && cfg.supervisedLocal === true) {
    throw new ProviderError(
      "bokahli: requireQualified and supervisedLocal are contradictory — supervised-local exists " +
        "to accept an UNQUALIFIED artifact under human review, so a request that demands " +
        "qualification can never be satisfied by it",
      { kind: "config", provider: BOKAHLI_PROVIDER_ID, retriable: false },
    );
  }
  if ((cfg.routeMode === "EXACT" || cfg.routeMode === "PROFILE") && str(cfg.target) === undefined) {
    throw new ProviderError(`bokahli: route mode ${cfg.routeMode} requires a target`, {
      kind: "config", provider: BOKAHLI_PROVIDER_ID, retriable: false,
    });
  }

  const token = readBokahliCredential(cfg.credentialFile);
  const baseUrl = (cfg.baseUrl ?? BOKAHLI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const maxBytes = cfg.maxResponseBytes ?? BOKAHLI_MAX_RESPONSE_BYTES;
  const timeoutMs = cfg.timeoutMs ?? 120_000;

  return {
    id: BOKAHLI_PROVIDER_ID,
    ready: () => true,
    preflightInfo: (): ProviderPreflightInfo => ({
      kind: "bokahli",
      baseUrl,
      credentialRequired: true,
      credentialPresent: true,
    }) as ProviderPreflightInfo,

    async invoke(invocation: ProviderInvocation): Promise<BokahliProviderResult> {
      // The caller's signal is honored as well as our own ceiling: cancellation must propagate
      // as far as the transport genuinely supports it, which for one fetch is the fetch itself.
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      invocation.signal.addEventListener("abort", onAbort, { once: true });
      if (invocation.signal.aborted) controller.abort();
      const effectiveTimeout = invocation.timeoutMs > 0 ? Math.min(invocation.timeoutMs, timeoutMs) : timeoutMs;
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          // A redirect is REFUSED, never followed: the endpoint an operator authorized and put a
          // credential behind is the only one this may talk to, and following a 3xx would send
          // that credential somewhere nobody approved.
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(buildRequestBody(invocation, cfg)),
        });
      } catch (cause) {
        const aborted = controller.signal.aborted;
        throw new ProviderError(
          aborted ? `bokahli did not respond within ${effectiveTimeout}ms (or the caller cancelled)` : `bokahli transport failed`,
          { kind: aborted ? "timeout" : "http", provider: BOKAHLI_PROVIDER_ID, retriable: true, cause },
        );
      } finally {
        clearTimeout(timer);
        invocation.signal.removeEventListener("abort", onAbort);
      }

      if (res.status >= 300 && res.status < 400) {
        throw new BokahliProtocolError(`endpoint answered with a redirect (${res.status}); refusing to follow it`, res.status);
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(`bokahli rejected the credential (HTTP ${res.status})`, {
          kind: "auth", provider: BOKAHLI_PROVIDER_ID, retriable: false, status: res.status,
        });
      }

      const text = await readBounded(res, maxBytes);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new BokahliProtocolError(`response was not valid JSON (${text.length} bytes, HTTP ${res.status})`, res.status);
      }

      const classified = classifyResponse(body, res.status);
      if (classified.kind === "refusal") throw classified.refusal;

      const binding = readLocalBinding(body);
      const stamp = decideSupervision(binding, cfg);
      return {
        ...readCompletion(body, res.status),
        ...(binding !== undefined ? { attestedIdentity: binding } : {}),
        ...(stamp !== undefined ? { supervision: stamp } : {}),
      };
    },
  };
}

/** The request body. The credential is a HEADER and never appears here. */
function buildRequestBody(invocation: ProviderInvocation, cfg: BokahliProviderConfig): Record<string, unknown> {
  const req = invocation.request;
  // AUTO lets the deployment choose from what it has; PROFILE and EXACT name what to use, and the
  // constructor already refused to build a provider for either without a target.
  const model = cfg.routeMode === "AUTO" ? invocation.providerModelId : (cfg.target ?? invocation.providerModelId);
  const messages = req.messages ?? (req.prompt !== undefined ? [{ role: "user", content: req.prompt }] : []);
  return {
    model,
    messages,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.tools !== undefined && req.tools.length > 0 ? { tools: req.tools } : {}),
    bokahli: {
      routeMode: cfg.routeMode,
      ...put("target", str(cfg.target)),
      ...put("taskClass", str(cfg.taskClass)),
      requireQualified: cfg.requireQualified,
      supervisedLocal: cfg.supervisedLocal === true,
    },
  };
}

/**
 * Read the body with a hard ceiling, so an endpoint that streams an unbounded response cannot
 * exhaust this process's memory before anything has had a chance to reject it.
 */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BokahliProtocolError(`response declares ${declared} bytes, over the ${maxBytes}-byte ceiling`, res.status);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new BokahliProtocolError(`response is ${buf.byteLength} bytes, over the ${maxBytes}-byte ceiling`, res.status);
  }
  return new TextDecoder().decode(buf);
}

/** Extract the completion. A body that claimed ROUTED but carries no usable message is a protocol fault. */
function readCompletion(body: unknown, status: number): ProviderResult {
  const root = obj(body) ?? {};
  const choices = Array.isArray(root["choices"]) ? (root["choices"] as unknown[]) : [];
  const first = obj(choices[0]);
  const message = first === undefined ? undefined : obj(first["message"]);
  if (message === undefined) throw new BokahliProtocolError("ROUTED response carries no message", status);

  const rawCalls = Array.isArray(message["tool_calls"]) ? (message["tool_calls"] as unknown[]) : [];
  const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
    const e = obj(c) ?? {};
    const fn = obj(e["function"]) ?? {};
    return {
      id: str(e["id"]) ?? `call_${i}`,
      name: str(fn["name"]) ?? "",
      arguments: str(fn["arguments"]) ?? "{}",
    } as ToolCall;
  });

  const usageRaw = obj(root["usage"]) ?? {};
  const usage: TokenUsage = {
    promptTokens: num(usageRaw["prompt_tokens"]) ?? 0,
    completionTokens: num(usageRaw["completion_tokens"]) ?? 0,
    totalTokens: num(usageRaw["total_tokens"]) ?? 0,
  };

  const finish = str(first?.["finish_reason"]);
  const finishReason: FinishReason =
    finish === "tool_calls" ? "tool_calls" : finish === "length" ? "length" : "stop";

  return {
    content: str(message["content"]) ?? "",
    ...put("servedModelId", str(root["model"])),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    finishReason,
    usage,
  };
}

/**
 * Decide how a served result must be treated.
 *
 * THE ORDER MATTERS. `requireQualified` is checked first and refuses outright: a request that
 * demanded qualification must never be quietly downgraded into "here it is, but please review
 * it" — the caller asked a question whose only honest answers are a qualified result or a typed
 * escalation. Only after that does supervised-local apply, and only when it was explicitly
 * requested. An unqualified answer with neither flag set is refused rather than returned bare.
 */
export function decideSupervision(
  binding: BokahliLocalBinding | undefined,
  cfg: Pick<BokahliProviderConfig, "requireQualified" | "supervisedLocal">,
): SupervisedLocalStamp | undefined {
  const status = binding?.qualificationStatus ?? "UNKNOWN";
  const authority = binding?.qualificationAuthority ?? "unknown";
  /*
    QUALIFIED MEANS A NAMED AUTHORITY SAID SO. "UNKNOWN" and "INSTALLED_UNQUALIFIED" are both the
    absence of that, and absence is never read as consent.

    The authority is checked with an ALLOW-list of things that do not count rather than by
    trusting any non-empty string: an earlier version tested `!== "none" && !== "unknown"`, which
    accepted `""` — a body claiming QUALIFIED with an empty authority would have been treated as
    genuinely qualified. A downgrade attempt does not have to be clever to work; it only has to
    find the one value nobody thought about.
  */
  const namedAuthority = authority.trim();
  const authorityCounts =
    namedAuthority.length > 0 && !["none", "unknown", "null", "undefined", "-"].includes(namedAuthority.toLowerCase());
  const qualified = status === "QUALIFIED" && authorityCounts;

  if (cfg.requireQualified) {
    if (qualified) return undefined; // a qualified result needs no supervision stamp
    throw new BokahliRefusal({
      outcome: "REFUSED",
      reason: "MODEL_NOT_QUALIFIED_FOR_TASK",
      detail:
        `the request required a qualified artifact; the deployment served qualification ` +
        `status ${status} under authority ${authority}. Refusing rather than downgrading to ` +
        `supervised-local — that would answer a question the caller did not ask.`,
      ...(binding !== undefined ? { localBinding: binding } : {}),
    });
  }

  if (qualified) return undefined;

  if (cfg.supervisedLocal !== true) {
    throw new BokahliRefusal({
      outcome: "REFUSED",
      reason: "NO_QUALIFIED_LOCAL_ROUTE",
      detail:
        `the deployment served an artifact with qualification status ${status} (authority ` +
        `${authority}) and supervised-local was not requested. Set it explicitly to accept an ` +
        `unqualified local result for human review.`,
      ...(binding !== undefined ? { localBinding: binding } : {}),
    });
  }

  return {
    executionClass: "local",
    qualified: false,
    humanReviewRequired: true,
    autonomousPromotionAllowed: false,
    reason:
      `served by a local artifact with qualification status ${status} (authority ${authority}); ` +
      `accepted under an explicit supervised-local request and NOT eligible for autonomous promotion`,
  };
}
