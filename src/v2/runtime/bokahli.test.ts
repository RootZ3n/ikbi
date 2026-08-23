/**
 * BOKAHLI AT THE V2 SEAM, against a HOSTILE server (DD-05).
 *
 * The fixtures here were not written by reading Bokahli's happy path. They were written by asking
 * what a local deployment could send — through a bug, a version skew, or something impersonating
 * it on a loopback port — that this adapter might mistake for an answer. Every one of them must
 * end in a typed refusal rather than in prose handed to a builder as if a model had spoken.
 *
 * The live contract is checked separately (`bokahli-live.test.ts`); this file is about behavior
 * that must hold whatever the deployment does.
 */

import "../test-env.js";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BOKAHLI_ESCALATE_REASONS,
  BOKAHLI_OUTCOMES,
  BOKAHLI_PROVIDER_ID,
  BokahliProtocolError,
  BokahliRefusal,
  classifyResponse,
  createBokahliProvider,
  decideSupervision,
  readBokahliCredential,
  readLocalBinding,
  type BokahliProviderConfig,
  type BokahliProviderResult,
} from "./bokahli.js";
import type { ProviderInvocation } from "../../core/provider/contract.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const TOKEN = "bokahli-test-token-value-not-a-real-secret";

/** A mode-0600 regular credential file. */
function credential(mode = 0o600): string {
  const d = mkdtempSync(join(tmpdir(), "bok-cred-"));
  dirs.push(d);
  const p = join(d, "token");
  writeFileSync(p, `${TOKEN}\n`);
  chmodSync(p, mode);
  return p;
}

const SERVED = {
  modelId: "qwen3.5-35b-a3b.q2-k",
  artifactDigest: "sha256:49533d47d170c0dad00e38f3aab0d8a5556654caa8144a7e6f3480c8e6761201",
  quantization: "Q2_K",
  servedContextTokens: 32768,
  backendInstanceId: "inst-7",
  attested: true,
  attestationMethod: "digest-match",
  qualification: { status: "INSTALLED_UNQUALIFIED", authority: "none" },
  runtime: { build: "bokahli/0.4.1" },
};

function routedBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cmpl-1",
    model: "qwen3.5-35b-a3b.q2-k",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    bokahli: { servedIdentity: { ...SERVED, outcome: "ROUTED" } },
    ...over,
  };
}

/** Every request the fake server saw, so the token can be proven absent from what we report. */
const seen: { url: string; headers: Record<string, string>; body: string }[] = [];

/** A fetch that answers with `respond(url, init)`. No socket, no port, no cleanup. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({ url, headers, body: String(init?.body ?? "") });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function invocation(): ProviderInvocation {
  return {
    providerModelId: "qwen3.5-35b-a3b.q2-k",
    request: { model: "local", prompt: "hi", identity: { agentId: "t", functionalRole: "builder", trustTier: "worker" } as never },
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

function provider(over: Partial<BokahliProviderConfig>, respond: (u: string, i: RequestInit) => Response | Promise<Response>) {
  return createBokahliProvider({
    credentialFile: credential(),
    routeMode: "AUTO",
    requireQualified: false,
    supervisedLocal: true,
    fetchImpl: fakeFetch(respond),
    ...over,
  });
}

/** Invoke and return the thrown error, asserting that something WAS thrown. */
async function refusal(p: { invoke(i: ProviderInvocation): Promise<unknown> }): Promise<unknown> {
  try {
    const r = await p.invoke(invocation());
    assert.fail(`expected a refusal, got a result: ${JSON.stringify(r).slice(0, 200)}`);
  } catch (e) {
    return e;
  }
}

// ── credential ──────────────────────────────────────────────────────────────

test("DD-05: a mode-0600 regular file is accepted", () => {
  assert.equal(readBokahliCredential(credential()), TOKEN);
});

test("DD-05: a group- or world-readable credential is REFUSED before it is read", () => {
  for (const mode of [0o640, 0o604, 0o644, 0o660]) {
    assert.throws(() => readBokahliCredential(credential(mode)), /must not be\s+readable by group or others|must not be readable by group or others/,
      `mode ${mode.toString(8)} must be refused`);
  }
});

test("DD-05: a SYMLINK credential is refused, not followed", () => {
  const real = credential();
  const d = mkdtempSync(join(tmpdir(), "bok-link-"));
  dirs.push(d);
  const link = join(d, "token-link");
  symlinkSync(real, link);
  assert.throws(() => readBokahliCredential(link), /symlink/, "the checked file must be the read file");
});

test("DD-05: a missing or empty credential is refused", () => {
  assert.throws(() => readBokahliCredential(join(tmpdir(), "bok-nope", "token")), /not readable/);
  const d = mkdtempSync(join(tmpdir(), "bok-empty-"));
  dirs.push(d);
  const p = join(d, "token");
  writeFileSync(p, "   \n");
  chmodSync(p, 0o600);
  assert.throws(() => readBokahliCredential(p), /empty/);
});

test("DD-05: the token never appears in argv, the request body, or a captured report", async () => {
  seen.length = 0;
  const p = provider({}, () => json(routedBody()));
  await p.invoke(invocation());
  const rec = seen.at(-1);
  assert.ok(rec !== undefined);
  assert.equal(rec.body.includes(TOKEN), false, "the token is a header, never the body");
  assert.equal(rec.url.includes(TOKEN), false, "and never the URL");
  assert.equal(process.argv.join(" ").includes(TOKEN), false, "and never process arguments");
  // It IS in the Authorization header — that is where it belongs, and nowhere else.
  assert.equal(rec.headers["authorization"], `Bearer ${TOKEN}`);
});

// ── construction policy ─────────────────────────────────────────────────────

test("DD-05: requireQualified + supervisedLocal is refused at construction", () => {
  assert.throws(
    () => createBokahliProvider({ credentialFile: credential(), routeMode: "AUTO", requireQualified: true, supervisedLocal: true, fetchImpl: fakeFetch(() => json({})) }),
    /contradictory/,
  );
});

test("DD-05: PROFILE and EXACT require a target; AUTO does not", () => {
  for (const routeMode of ["PROFILE", "EXACT"] as const) {
    assert.throws(() => createBokahliProvider({ credentialFile: credential(), routeMode, requireQualified: false, supervisedLocal: true, fetchImpl: fakeFetch(() => json({})) }), /requires a target/);
  }
  assert.ok(createBokahliProvider({ credentialFile: credential(), routeMode: "AUTO", requireQualified: false, supervisedLocal: true, fetchImpl: fakeFetch(() => json({})) }));
});

test("DD-05: AUTO, PROFILE and EXACT each send what they mean", async () => {
  for (const [routeMode, target, expected] of [["AUTO", undefined, "qwen3.5-35b-a3b.q2-k"], ["PROFILE", "cheap-local", "cheap-local"], ["EXACT", "qwen3.5-35b-a3b.q2-k", "qwen3.5-35b-a3b.q2-k"]] as const) {
    seen.length = 0;
    const p = provider({ routeMode, ...(target !== undefined ? { target } : {}), taskClass: "edit" }, () => json(routedBody()));
    await p.invoke(invocation());
    const body = JSON.parse(seen.at(-1)?.body ?? "{}") as { model: string; bokahli: Record<string, unknown> };
    assert.equal(body.model, expected, routeMode);
    assert.equal(body.bokahli["routeMode"], routeMode);
    assert.equal(body.bokahli["taskClass"], "edit");
    assert.equal(body.bokahli["requireQualified"], false);
  }
});

// ── ROUTED ──────────────────────────────────────────────────────────────────

test("DD-05: a normal ROUTED response yields content, servedModelId AND the attested binding", async () => {
  const p = provider({}, () => json(routedBody()));
  const r = (await p.invoke(invocation())) as BokahliProviderResult;
  assert.equal(r.content, "hello");
  assert.equal(r.servedModelId, "qwen3.5-35b-a3b.q2-k", "the CLAIM");
  assert.equal(r.attestedIdentity?.artifactDigest, SERVED.artifactDigest, "and the separately-carried PROOF");
  assert.equal(r.attestedIdentity?.attested, true);
  assert.equal(r.attestedIdentity?.qualificationStatus, "INSTALLED_UNQUALIFIED");
  assert.equal(r.attestedIdentity?.qualificationAuthority, "none");
  assert.equal(r.attestedIdentity?.servedContextTokens, 32768);
  assert.equal(r.attestedIdentity?.runtimeBuild, "bokahli/0.4.1");
  assert.equal(r.usage.totalTokens, 13);
});

test("DD-05: servedModelId and localBinding stay SEPARATE facts", async () => {
  // The runtime claims one id while attesting a different artifact — a substitution. Both are
  // reported verbatim so the disagreement is visible instead of being averaged away.
  const p = provider({}, () => json(routedBody({ model: "something-else-entirely" })));
  const r = (await p.invoke(invocation())) as BokahliProviderResult;
  assert.equal(r.servedModelId, "something-else-entirely");
  assert.equal(r.attestedIdentity?.modelId, "qwen3.5-35b-a3b.q2-k");
  assert.notEqual(r.servedModelId, r.attestedIdentity?.modelId, "the mismatch survives into the evidence");
});

// ── non-ROUTED outcome families ─────────────────────────────────────────────

test("DD-05: every non-ROUTED outcome family is a TYPED refusal, never prose", async () => {
  const cases: [string, string, number][] = [
    ["ESCALATE", "NO_QUALIFIED_LOCAL_ROUTE", 200],
    ["ESCALATE", "CONTEXT_EXCEEDS_LOCAL_CAPABILITY", 200],
    ["REFUSED", "MODEL_NOT_QUALIFIED_FOR_TASK", 200],
    ["CAPACITY_UNAVAILABLE", "QUEUE_FULL", 503],
    ["CAPACITY_UNAVAILABLE", "RUNTIME_UNHEALTHY", 503],
  ];
  for (const [outcome, reason, status] of cases) {
    const p = provider({}, () => json({ outcome, route: { reason, detail: "nope" } }, status));
    const e = await refusal(p);
    assert.ok(e instanceof BokahliRefusal, `${outcome}/${reason} → ${String(e)}`);
    assert.equal(e.outcome, outcome);
    assert.equal(e.reason, reason);
    assert.equal(e.provider, BOKAHLI_PROVIDER_ID);
  }
});

test("DD-05: a transient refusal is retriable; a decision about setup is NOT", async () => {
  const transient = (await refusal(provider({}, () => json({ outcome: "CAPACITY_UNAVAILABLE", route: { reason: "QUEUE_FULL", detail: "busy" } }, 503)))) as BokahliRefusal;
  assert.equal(transient.retriable, true, "a full queue clears on its own");
  const settled = (await refusal(provider({}, () => json({ outcome: "REFUSED", route: { reason: "NO_LOCAL_CANDIDATES", detail: "nothing installed" } })))) as BokahliRefusal;
  assert.equal(settled.retriable, false, "retrying what is installed changes nothing");
});

test("DD-05: swap candidates survive into the refusal", async () => {
  const p = provider({}, () => json({ outcome: "ESCALATE", route: { reason: "LOCAL_MODEL_SWAP_REQUIRED", detail: "swap", swap: { candidates: [{ modelId: "other", coldLoadSeconds: 42 }] } } }));
  const e = (await refusal(p)) as BokahliRefusal;
  assert.deepEqual(e.swapCandidates, [{ modelId: "other", coldLoadSeconds: 42 }]);
});

// ── fail-closed protocol handling ───────────────────────────────────────────

test("DD-05: an UNKNOWN outcome fails closed", () => {
  assert.throws(() => classifyResponse({ outcome: "PROBABLY_FINE", route: { reason: "NO_LOCAL_CANDIDATES" } }, 200), /unknown outcome/);
});

test("DD-05: an UNKNOWN reason fails closed", () => {
  assert.throws(() => classifyResponse({ outcome: "ESCALATE", route: { reason: "VIBES", detail: "x" } }, 200), /unknown reason/);
});

test("DD-05: a reason under the WRONG outcome fails closed", () => {
  // QUEUE_FULL is a capacity fact; it may not masquerade as a routing decision.
  assert.throws(() => classifyResponse({ outcome: "ESCALATE", route: { reason: "QUEUE_FULL", detail: "x" } }, 200), /may not accompany outcome/);
  // And a swap request is never a capacity answer.
  assert.throws(() => classifyResponse({ outcome: "CAPACITY_UNAVAILABLE", route: { reason: "LOCAL_MODEL_SWAP_REQUIRED", detail: "x" } }, 503), /may not accompany outcome/);
});

test("DD-05: STATUS and BODY must agree", () => {
  // A completion body under a failure status.
  assert.throws(() => classifyResponse(routedBody(), 500), /status and body disagree/);
  // ROUTED under a failure status.
  assert.throws(() => classifyResponse({ ...routedBody(), outcome: "ROUTED" }, 502), /status and body disagree/);
  // A refusal that also carries choices.
  assert.throws(() => classifyResponse({ outcome: "REFUSED", route: { reason: "NO_LOCAL_CANDIDATES", detail: "x" }, choices: [{ message: { content: "hi" } }] }, 200), /status and body disagree/);
});

test("DD-05: a body that is neither outcome, error, nor completion fails closed", () => {
  assert.throws(() => classifyResponse({ hello: "world" }, 200), /neither an outcome, a typed error, nor choices/);
  assert.throws(() => classifyResponse("a string", 200), /not a JSON object/);
  assert.throws(() => classifyResponse(null, 200), /not a JSON object/);
});

test("DD-05: an outcome with NO reason fails closed", () => {
  assert.throws(() => classifyResponse({ outcome: "REFUSED" }, 200), /carries no reason/);
});

test("DD-05: a REDIRECT is refused, never followed", async () => {
  const p = provider({}, () => new Response(null, { status: 302, headers: { location: "http://elsewhere.invalid/v1" } }));
  const e = await refusal(p);
  assert.ok(e instanceof BokahliProtocolError, String(e));
  assert.match((e as Error).message, /redirect/);
});

test("DD-05: TRUNCATED JSON fails closed", async () => {
  const p = provider({}, () => new Response('{"choices":[{"message":', { status: 200, headers: { "content-type": "application/json" } }));
  const e = await refusal(p);
  assert.ok(e instanceof BokahliProtocolError);
  assert.match((e as Error).message, /not valid JSON/);
});

test("DD-05: an OVERSIZED body is refused — by declared length and by actual bytes", async () => {
  const declared = provider({ maxResponseBytes: 64 }, () => json(routedBody(), 200, { "content-length": "999999" }));
  assert.match(String(await refusal(declared)), /over the 64-byte ceiling/);
  const actual = provider({ maxResponseBytes: 64 }, () => new Response("x".repeat(500), { status: 200 }));
  assert.match(String(await refusal(actual)), /over the 64-byte ceiling/);
});

test("DD-05: a 401/403 is an AUTH failure, not a routing decision", async () => {
  for (const status of [401, 403]) {
    const e = (await refusal(provider({}, () => json({ error: { code: "UNAUTHORIZED", message: "nope" } }, status)))) as { kind: string; retriable: boolean };
    assert.equal(e.kind, "auth", `HTTP ${status}`);
    assert.equal(e.retriable, false, "a rejected credential does not fix itself");
  }
});

test("DD-05: a ROUTED body with no message fails closed rather than yielding empty content", async () => {
  const p = provider({}, () => json({ id: "x", model: "m", choices: [{ index: 0, finish_reason: "stop" }] }));
  assert.match(String(await refusal(p)), /carries no message/);
});

// ── identity handling ───────────────────────────────────────────────────────

test("DD-05: an absent binding is ABSENT — never defaulted to something favorable", () => {
  assert.equal(readLocalBinding({ choices: [] }), undefined);
  assert.equal(readLocalBinding({ bokahli: {} }), undefined);
  // modelId without a digest is not an identity.
  assert.equal(readLocalBinding({ bokahli: { servedIdentity: { modelId: "m" } } }), undefined);
});

test("DD-05: an UNATTESTED response reports attested:false, and unknown qualification stays UNKNOWN", () => {
  const b = readLocalBinding({ bokahli: { servedIdentity: { modelId: "m", artifactDigest: "sha256:aa" } } });
  assert.equal(b?.attested, false, "absence is never read as attested");
  assert.equal(b?.qualificationStatus, "UNKNOWN", "unknown is a fact; INSTALLED_UNQUALIFIED would be a claim");
  assert.equal(b?.qualificationAuthority, "unknown");
});

// ── supervised-local policy ─────────────────────────────────────────────────

const unqualified = { modelId: "m", artifactDigest: "sha256:aa", attested: true, qualificationStatus: "INSTALLED_UNQUALIFIED", qualificationAuthority: "none", outcome: "ROUTED" };
const qualified = { ...unqualified, qualificationStatus: "QUALIFIED", qualificationAuthority: "luak" };

test("DD-05: supervised-local stamps the result structurally", async () => {
  const p = provider({ supervisedLocal: true, requireQualified: false }, () => json(routedBody()));
  const r = (await p.invoke(invocation())) as BokahliProviderResult;
  assert.deepEqual(
    { ...r.supervision, reason: undefined },
    { executionClass: "local", qualified: false, humanReviewRequired: true, autonomousPromotionAllowed: false, reason: undefined },
  );
  assert.match(r.supervision?.reason ?? "", /NOT eligible for autonomous promotion/);
});

test("DD-05: an unqualified result WITHOUT supervised-local is refused, not returned bare", async () => {
  const p = provider({ supervisedLocal: false, requireQualified: false }, () => json(routedBody()));
  const e = (await refusal(p)) as BokahliRefusal;
  assert.equal(e.reason, "NO_QUALIFIED_LOCAL_ROUTE");
  assert.match(e.detail, /supervised-local was not requested/);
});

/** Run `fn`, returning what it threw. Fails the test if it returned normally. */
function thrown(fn: () => unknown): unknown {
  try {
    const v = fn();
    assert.fail(`expected a throw, got ${JSON.stringify(v)}`);
  } catch (e) {
    return e;
  }
}

test("DD-05: requireQualified NEVER downgrades into supervised-local", () => {
  const e = thrown(() => decideSupervision(unqualified, { requireQualified: true, supervisedLocal: false })) as BokahliRefusal;
  assert.ok(e instanceof BokahliRefusal, String(e));
  assert.equal(e.outcome, "REFUSED");
  assert.equal(e.reason, "MODEL_NOT_QUALIFIED_FOR_TASK");
  assert.match(e.detail, /Refusing rather than downgrading/);
});

test("DD-05: a QUALIFICATION DOWNGRADE ATTEMPT cannot buy supervision-free acceptance", () => {
  // A body claiming QUALIFIED but naming no authority is not qualified.
  // Every value that names no real authority. `""` is the one an earlier version of this policy
  // accepted, which is why the check is an explicit list rather than "not none, not unknown".
  for (const authority of ["none", "unknown", "", "   ", "NONE", "null", "-"]) {
    const b = { ...unqualified, qualificationStatus: "QUALIFIED", qualificationAuthority: authority };
    const e = thrown(() => decideSupervision(b, { requireQualified: true, supervisedLocal: false }));
    assert.ok(e instanceof BokahliRefusal, `authority=${JSON.stringify(authority)} must be refused, got ${String(e)}`);
  }
  // A genuinely qualified artifact needs no stamp and is accepted under requireQualified.
  assert.equal(decideSupervision(qualified, { requireQualified: true, supervisedLocal: false }), undefined);
});

test("DD-05: a missing binding is treated as UNQUALIFIED, not as permission", () => {
  assert.throws(() => decideSupervision(undefined, { requireQualified: true, supervisedLocal: false }), BokahliRefusal);
  assert.throws(() => decideSupervision(undefined, { requireQualified: false, supervisedLocal: false }), BokahliRefusal);
  const stamp = decideSupervision(undefined, { requireQualified: false, supervisedLocal: true });
  assert.equal(stamp?.qualified, false);
});

// ── accounting ──────────────────────────────────────────────────────────────

test("DD-05: exactly ONE wire attempt per invocation, on success and on refusal alike", async () => {
  for (const respond of [
    () => json(routedBody()),
    () => json({ outcome: "REFUSED", route: { reason: "NO_LOCAL_CANDIDATES", detail: "x" } }),
    () => json({ outcome: "CAPACITY_UNAVAILABLE", route: { reason: "QUEUE_FULL", detail: "x" } }, 503),
  ]) {
    seen.length = 0;
    const p = provider({}, respond);
    await p.invoke(invocation()).catch(() => undefined);
    assert.equal(seen.length, 1, "one invocation dials the provider exactly once — no retry, no fallback");
  }
});

test("DD-05: the reason lists are non-empty and every outcome is covered", () => {
  assert.ok(BOKAHLI_ESCALATE_REASONS.length >= 8);
  assert.deepEqual([...BOKAHLI_OUTCOMES], ["ROUTED", "ESCALATE", "REFUSED", "CAPACITY_UNAVAILABLE"]);
});
