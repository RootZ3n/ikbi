/**
 * BOKAHLI, AGAINST THE REAL DEPLOYMENT (DD-06).
 *
 * `bokahli.test.ts` checks this adapter's behavior against fixtures. That is the right shape for
 * logic and exactly the wrong shape for a WIRE CONTRACT: the fixtures were written by reading
 * Bokahli's responses, so they would keep passing after a rename on the other side of the socket.
 * The reason list and the response shape are hand-maintained copies of things that live in
 * another repository, and this is what keeps the copies honest.
 *
 * IT SPENDS NOTHING AND CHANGES NOTHING. Every request here is metadata, a routing decision, or a
 * single tiny bounded completion. No paid provider is contacted, no repository is mutated, and
 * the deployment is neither restarted nor reconfigured.
 *
 * SKIPPING IS A RESULT, NOT AN ABSENCE. The probe runs at MODULE SCOPE because `node:test` reads
 * the `skip` option when a test is REGISTERED — a `before()` hook that set a flag afterwards has
 * already missed its chance, and the first version of a suite like this reported "8 skipped"
 * against a healthy deployment, which is the worst outcome available to a drift detector. With
 * `IKBI_BOKAHLI_REQUIRE_LIVE=true` every reason to skip becomes a reason to FAIL, naming the
 * cause; a developer checkout without a Mushin skips legibly instead.
 */

import "../test-env.js";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOKAHLI_ESCALATE_REASONS,
  BokahliRefusal,
  createBokahliProvider,
  readLocalBinding,
  type BokahliProviderResult,
} from "./bokahli.js";
import type { ProviderInvocation } from "../../core/provider/contract.js";

const BASE = process.env["IKBI_BOKAHLI_BASE_URL"] ?? "http://127.0.0.1:8080/v1";
const TOKEN_FILE = process.env["IKBI_BOKAHLI_TOKEN_FILE"] ?? join(process.env["HOME"] ?? "", ".config/bokahli/token");
const REQUIRE_LIVE = process.env["IKBI_BOKAHLI_REQUIRE_LIVE"] === "true";
const EXPECT_MODEL = process.env["IKBI_BOKAHLI_EXPECT_MODEL"] ?? null;
const EXPECT_DIGEST = process.env["IKBI_BOKAHLI_EXPECT_DIGEST"] ?? null;

/** Non-null when the deployment cannot be used, saying exactly why. */
const skipReason: string | null = await (async (): Promise<string | null> => {
  if (!existsSync(TOKEN_FILE)) return `no credential file at ${TOKEN_FILE}`;
  if (lstatSync(TOKEN_FILE).isSymbolicLink()) return `${TOKEN_FILE} is a symlink`;
  if ((lstatSync(TOKEN_FILE).mode & 0o077) !== 0) return `${TOKEN_FILE} is not mode 0600`;
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${readFileSync(TOKEN_FILE, "utf8").trim()}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return `${BASE}/models returned ${r.status}`;
  } catch (e) {
    return `${BASE} unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
})();

if (REQUIRE_LIVE && skipReason !== null) {
  // A release gate that skips is a gate that passed without checking anything.
  throw new Error(`IKBI_BOKAHLI_REQUIRE_LIVE=true but the deployment is unusable: ${skipReason}`);
}
const live = { skip: skipReason ?? false };

function invocation(prompt: string, maxTokens = 32): ProviderInvocation {
  return {
    providerModelId: EXPECT_MODEL ?? "qwen3.5-35b-a3b.q2-k",
    request: { model: "local", prompt, maxTokens, identity: { agentId: "live", functionalRole: "builder", trustTier: "worker" } as never },
    timeoutMs: 120_000,
    signal: new AbortController().signal,
  };
}

const supervised = () =>
  createBokahliProvider({ baseUrl: BASE, credentialFile: TOKEN_FILE, routeMode: "AUTO", requireQualified: false, supervisedLocal: true, taskClass: "edit" });

// ── metadata ────────────────────────────────────────────────────────────────

test("DD-06 live: the deployment serves an ATTESTED artifact with a digest and a qualification state", live, async () => {
  const r = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${readFileSync(TOKEN_FILE, "utf8").trim()}` } });
  assert.equal(r.ok, true);
  const body = (await r.json()) as { data: { id: string; bokahli?: Record<string, unknown> }[] };
  assert.ok(body.data.length > 0, "the catalog is not empty");
  for (const m of body.data) {
    const b = m.bokahli as { digest?: string; attested?: boolean; qualification?: { status?: string; authority?: string } } | undefined;
    assert.ok(typeof b?.digest === "string" && b.digest.startsWith("sha256:"), `${m.id} reports a content digest`);
    assert.equal(typeof b?.attested, "boolean", `${m.id} states its attestation result`);
    assert.ok(typeof b?.qualification?.status === "string", `${m.id} states a qualification status`);
    assert.ok(typeof b?.qualification?.authority === "string", `${m.id} names a qualification authority`);
  }
  if (EXPECT_MODEL !== null) {
    const m = body.data.find((x) => x.id === EXPECT_MODEL);
    assert.ok(m !== undefined, `the expected artifact ${EXPECT_MODEL} is served`);
    if (EXPECT_DIGEST !== null) {
      assert.equal((m.bokahli as { digest: string }).digest, EXPECT_DIGEST, "and it is the expected ARTIFACT, not merely the expected name");
    }
  }
});

test("DD-06 live: an UNAUTHENTICATED request is rejected", live, async () => {
  const r = await fetch(`${BASE}/models`);
  assert.equal(r.status, 401, "the deployment requires the credential");
});

// ── supervised-local inference ──────────────────────────────────────────────

test("DD-06 live: a supervised-local request is served, stamped, and bound to the exact artifact", live, async () => {
  const r = (await supervised().invoke(invocation("Reply with exactly the word: ready"))) as BokahliProviderResult;
  assert.ok(r.content.length > 0, "the local worker produced content");
  assert.ok(typeof r.servedModelId === "string" && r.servedModelId.length > 0, "the runtime CLAIMED an identity");
  assert.ok(r.attestedIdentity !== undefined, "and ATTESTED one");
  assert.ok(r.attestedIdentity.artifactDigest.startsWith("sha256:"), "with a content digest");
  assert.equal(r.attestedIdentity.attested, true);
  // The whole point of supervised-local: useful, and explicitly not trusted.
  assert.equal(r.supervision?.executionClass, "local");
  assert.equal(r.supervision?.qualified, false);
  assert.equal(r.supervision?.humanReviewRequired, true);
  assert.equal(r.supervision?.autonomousPromotionAllowed, false);
  if (EXPECT_DIGEST !== null) assert.equal(r.attestedIdentity.artifactDigest, EXPECT_DIGEST);
});

test("DD-06 live: requireQualified returns a TYPED escalation, never an unqualified answer", live, async () => {
  const strict = createBokahliProvider({ baseUrl: BASE, credentialFile: TOKEN_FILE, routeMode: "AUTO", requireQualified: true, taskClass: "edit" });
  try {
    const r = await strict.invoke(invocation("Reply with exactly the word: ready"));
    assert.fail(`an INSTALLED_UNQUALIFIED deployment must not satisfy requireQualified: ${JSON.stringify(r).slice(0, 200)}`);
  } catch (e) {
    assert.ok(e instanceof BokahliRefusal, `expected a typed refusal, got ${String(e)}`);
    assert.ok(["ESCALATE", "REFUSED"].includes(e.outcome), e.outcome);
    assert.ok((BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(e.reason), `reason ${e.reason} is one this adapter knows`);
    assert.equal(e.retriable, false, "a qualification decision is not a transient fault");
  }
});

test("DD-06 live: a WRONG artifact id is refused — never silently substituted", live, async () => {
  const exact = createBokahliProvider({
    baseUrl: BASE, credentialFile: TOKEN_FILE, routeMode: "EXACT",
    target: "definitely-not-installed-9f3a", requireQualified: false, supervisedLocal: true,
  });
  try {
    const r = (await exact.invoke(invocation("hi"))) as BokahliProviderResult;
    // If it answered at all, it must NOT have quietly served something else under that name.
    assert.notEqual(r.attestedIdentity?.modelId, "definitely-not-installed-9f3a");
    assert.fail(`an uninstalled artifact must not produce a completion: served ${r.attestedIdentity?.modelId}`);
  } catch (e) {
    assert.ok(e instanceof BokahliRefusal || (e as Error).name === "BokahliProtocolError" || (e as { kind?: string }).kind !== undefined,
      `expected a typed refusal, got ${String(e)}`);
  }
});

test("DD-06 live: the escalate-reason list this adapter carries matches the deployment's", live, async () => {
  // The deployment is asked for something it cannot do; whatever reason it names must be one this
  // adapter already knows, or the hand-maintained copy has drifted.
  const strict = createBokahliProvider({ baseUrl: BASE, credentialFile: TOKEN_FILE, routeMode: "AUTO", requireQualified: true, taskClass: "formal-verification" });
  try {
    await strict.invoke(invocation("hi"));
  } catch (e) {
    if (e instanceof BokahliRefusal) {
      assert.ok((BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(e.reason) || e.reason === "MODEL_NOT_QUALIFIED_FOR_TASK",
        `the deployment named reason ${e.reason}, which this adapter's copy does not list`);
    }
  }
});

test("DD-06 live: readLocalBinding parses what the REAL deployment sends", live, async () => {
  const r = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${readFileSync(TOKEN_FILE, "utf8").trim()}` } });
  const body = (await r.json()) as { data: { id: string; bokahli: Record<string, unknown> }[] };
  const first = body.data[0];
  assert.ok(first !== undefined);
  // Shaped as a completion would carry it, from the catalog's own fields.
  const b = readLocalBinding({ requestId: "x", bokahli: { servedIdentity: { modelId: first.id, ...first.bokahli, artifactDigest: first.bokahli["digest"] } } });
  assert.ok(b !== undefined, "the real catalog shape is parseable");
  assert.equal(b.modelId, first.id);
  assert.ok(b.artifactDigest.startsWith("sha256:"));
  assert.equal(b.qualificationStatus, (first.bokahli["qualification"] as { status: string }).status);
});
