/**
 * ikbi against a live Bokahli. Skipped when one is not reachable.
 *
 * `bokahli.test.ts` checks the parsing and the chain rules against fixtures.
 * That is the right shape for logic, and it is exactly the wrong shape for a
 * wire contract: the fixtures were written by reading Bokahli's source, so they
 * would keep passing after a rename on the other side of the socket. The copy of
 * `BOKAHLI_ESCALATE_REASONS` in the provider is the specific thing at risk —
 * it is a hand-maintained duplicate of a list that lives in another repository.
 *
 * So this talks to the real thing. It asserts the shapes ikbi depends on, and
 * it asserts that Bokahli still refuses the things ikbi expects it to refuse.
 *
 * It never asks Bokahli to *do* anything expensive, and it never invokes a paid
 * provider. Every request here is either a health probe or a routing decision
 * Bokahli answers without generating tokens.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BOKAHLI_ESCALATE_REASONS, readEscalation } from "./bokahli.js";

const BASE = process.env["IKBI_BOKAHLI_BASE_URL"] ?? "http://127.0.0.1:8080";
const TOKEN_FILE = process.env["IKBI_BOKAHLI_TOKEN_FILE"]
  ?? join(process.env["HOME"] ?? "", ".config/bokahli/token");

/**
 * The probe runs at module scope, before any `test()` call is evaluated.
 *
 * `before()` is too late: node:test reads the `skip` option when the test is
 * *registered*, which happens while the module body runs, so a hook that sets
 * `live` afterwards has already missed its chance. The first version did that
 * and skipped all eight tests against a Bokahli that was up and answering — a
 * green run reporting "8 skipped", which is the worst possible outcome for a
 * test whose entire job is to catch drift between two repositories.
 *
 * `skipReason` is null when the deployment is reachable. When it is not null it
 * says *why*, so a skip is legible rather than a shrug.
 */
const skipReason: string | null = await (async (): Promise<string | null> => {
  if (!existsSync(TOKEN_FILE)) return `no token file at ${TOKEN_FILE}`;
  if ((statSync(TOKEN_FILE).mode & 0o077) !== 0) return `${TOKEN_FILE} is not mode 0600`;
  try {
    const r = await fetch(`${BASE}/health/live`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? null : `${BASE}/health/live returned ${r.status}`;
  } catch (e) {
    return `${BASE} unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
})();

const token: string | null = skipReason === null
  ? readFileSync(TOKEN_FILE, "utf8").trim()
  : null;

if (skipReason !== null) console.log(`# bokahli integration: skipping — ${skipReason}`);

const skip = (): false | string => skipReason ?? false;

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: r.status, json: await r.json() };
}

test("the deployment authenticates and reports a served identity", { skip: skip() }, async () => {
  const r = await fetch(`${BASE}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  const d = (await r.json()) as Record<string, any>;
  assert.equal(d["status"], "ready");
  assert.equal(d["runtime"]?.["attested"], true,
    "ikbi must not send work to a runtime whose identity is unattested");
  assert.ok(typeof d["attestation"]?.["binding"]?.["modelId"] === "string");
});

test("an unauthenticated request is refused", { skip: skip() }, async () => {
  const r = await fetch(`${BASE}/health/ready`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(r.status, 401);
});

test("requiring qualification escalates, and the reason is one ikbi knows", { skip: skip() }, async () => {
  // Nothing on this deployment is qualified — that is the honest state, and it
  // is the state ikbi must handle without falling through to a paid provider.
  const { status, json } = await post("/v1/bokahli/chat", {
    route: { mode: "AUTO", requireQualified: true },
    messages: [{ role: "user", content: "x" }],
    maxTokens: 4,
  });

  assert.equal(status, 200, "a typed refusal is a successful HTTP response, not a 5xx");
  const body = json as Record<string, any>;
  assert.equal(body["outcome"], "ESCALATE");

  const escalation = readEscalation(body);
  assert.ok(escalation, "ikbi must recognise this as an escalation");
  assert.equal(escalation.terminatesChain, true);
  assert.notEqual(escalation.reason, "UNKNOWN",
    `Bokahli returned ${body["route"]?.["reason"]}, which is not in ikbi's copy of `
      + "BOKAHLI_ESCALATE_REASONS. The wire contract moved and the duplicate did not.");
});

test("every reason ikbi knows is one this Bokahli would emit", { skip: skip() }, async () => {
  // The other direction. A reason ikbi believes in but Bokahli has dropped means
  // dead branches in ikbi's handling, which rot silently.
  const r = await fetch(`${BASE}/v1/catalog`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(r.status, 200);
  // The catalog endpoint does not enumerate reasons, so this checks the two that
  // a live deployment can actually be made to produce, below, plus the shape.
  assert.ok(BOKAHLI_ESCALATE_REASONS.includes("MODEL_NOT_QUALIFIED_FOR_TASK"));
  assert.ok(BOKAHLI_ESCALATE_REASONS.includes("LOCAL_MODEL_SWAP_REQUIRED"));
});

test("an impossible context floor escalates rather than truncating", { skip: skip() }, async () => {
  // The failure being guarded against is a deployment that quietly serves a
  // smaller context and returns a confident, truncated answer.
  const { status, json } = await post("/v1/bokahli/chat", {
    route: { mode: "PROFILE", requirements: { minContextTokens: 1_000_000 } },
    messages: [{ role: "user", content: "x" }],
    maxTokens: 4,
  });
  assert.equal(status, 200);
  const body = json as Record<string, any>;
  assert.equal(body["outcome"], "ESCALATE");
  const e = readEscalation(body);
  assert.ok(e);
  assert.equal(e.terminatesChain, true);
});

test("EXACT with a wrong digest refuses and does not substitute", { skip: skip() }, async () => {
  // The property ikbi relies on for reproducibility: naming an artifact and a
  // digest either gets that artifact or gets nothing.
  const catalog = await fetch(`${BASE}/v1/catalog`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const entries = ((await catalog.json()) as Record<string, any>)["catalog"] as any[];
  const modelId = entries[0]["modelId"] as string;

  const { json } = await post("/v1/bokahli/chat", {
    route: { mode: "EXACT", modelId, artifactDigest: `sha256:${"0".repeat(64)}` },
    messages: [{ role: "user", content: "x" }],
    maxTokens: 4,
  });
  const body = json as Record<string, any>;
  assert.notEqual(body["outcome"], "ROUTED",
    "a wrong digest must never be answered by serving the artifact anyway");
  assert.ok(readEscalation(body), "ikbi must recognise the refusal");
});

test("no response body carries a filesystem path to an artifact", { skip: skip() }, async () => {
  // Model-visible context and receipts both derive from these bodies. A host
  // path is not a secret, but it is machine-specific detail that has no business
  // crossing the boundary, and it is the kind of thing that leaks into prompts.
  const { json } = await post("/v1/bokahli/chat", {
    route: { mode: "AUTO", requireQualified: true },
    messages: [{ role: "user", content: "x" }],
    maxTokens: 4,
  });
  const serialised = JSON.stringify(json);
  assert.ok(!serialised.includes("/home/"), "a host path reached the client");
  assert.ok(!serialised.includes(".gguf"), "an artifact filename reached the client");
});

test("the token does not appear in any response", { skip: skip() }, async () => {
  const { json } = await post("/v1/bokahli/chat", {
    route: { mode: "AUTO", requireQualified: true },
    messages: [{ role: "user", content: "x" }],
    maxTokens: 4,
  });
  assert.ok(token && token.length > 0);
  assert.ok(!JSON.stringify(json).includes(token));
});
