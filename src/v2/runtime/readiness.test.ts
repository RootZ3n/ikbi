/**
 * V2-018 — V2 DAILY-DRIVER READINESS classification.
 *
 * The classifier is pure over an injected probe, so these suites pin the contract with no host:
 * required checks gate readiness, recommended misses are advisory, and an UNSELECTABLE route is
 * reported as a required failure with NO fallback language.
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { test } from "node:test";

import { assessV2Readiness, renderV2Readiness, runV2ReadinessCli, type GovernedExecReadiness, type V2ReadinessProbe } from "./readiness.js";

function probe(over: Partial<{
  git: boolean;
  bwrap: boolean;
  gx: GovernedExecReadiness;
  turns: ReturnType<V2ReadinessProbe["builderTurns"]>;
  envelope: Awaited<ReturnType<V2ReadinessProbe["contextEnvelope"]>>;
  routes: Awaited<ReturnType<V2ReadinessProbe["routes"]>>;
}> = {}): V2ReadinessProbe {
  return {
    git: () => over.git ?? true,
    bwrap: () => over.bwrap ?? true,
    governedExecChecks: () => over.gx ?? { resolved: true, permitted: true, programs: ["pnpm"], denied: [] },
    builderTurns: () => over.turns ?? { ok: true, maxTurns: 12, source: "default" },
    contextEnvelope: async () =>
      over.envelope ?? { ok: true, modelId: "alpha-1", window: 65_536, reservedCompletion: 8_192, maxInput: 53_796, estimator: "conservative_estimate", charsPerToken: 3.5, estimatorProvenance: "generic_default" },
    routes: async () => over.routes ?? { ok: true, builder: { modelId: "alpha-1", satisfiable: true }, critic: { modelId: "alpha-1", satisfiable: true } },
  };
}

test("readiness: a fully-configured host is READY", async () => {
  const r = await assessV2Readiness(probe());
  assert.equal(r.ready, true);
  assert.equal(r.requiredIssues, 0);
  assert.ok(r.checks.every((c) => c.ok));
});

test("readiness: a missing bwrap is RECOMMENDED-only — still ready", async () => {
  const r = await assessV2Readiness(probe({ bwrap: false }));
  assert.equal(r.ready, true, "a build with no terminal/exec can still run without a sandbox");
  const bwrap = r.checks.find((c) => c.name === "bwrap");
  assert.equal(bwrap?.level, "recommended");
  assert.equal(bwrap?.ok, false);
});

test("readiness: missing git is a REQUIRED failure — not ready", async () => {
  assert.equal((await assessV2Readiness(probe({ git: false }))).ready, false);
});

// ── V2-020/Phase 20: governed-exec readiness is about the REAL check commands ──

test("readiness: checks that governed-exec would REFUSE are NOT READY (the old check said green)", async () => {
  // The old probe only asked "is the allowlist non-empty?", so a cargo project whose `cargo test`
  // was not allowlisted passed doctor and then failed at execution time. Now the resolved command
  // is compared against the allowlist, so doctor answers about what would actually run.
  const r = await assessV2Readiness(probe({ gx: { resolved: true, permitted: false, programs: ["cargo"], denied: ["cargo"] } }));
  assert.equal(r.ready, false);
  const gx = r.checks.find((c) => c.name === "governed-exec");
  assert.equal(gx?.level, "required");
  assert.equal(gx?.ok, false);
  assert.match(gx?.detail ?? "", /NOT READY/);
  assert.match(gx?.detail ?? "", /cargo/, "it names the command that would be refused");
});

test("readiness: checks that cannot be DERIVED are DEGRADED, not a hard stop", async () => {
  // Not knowing what would run is a weaker statement than knowing it would be refused, and the
  // report must not conflate them — a repo with no manifest is not a broken host.
  const r = await assessV2Readiness(probe({ gx: { resolved: false, permitted: false, programs: [], denied: [], reason: "no project manifest" } }));
  assert.equal(r.ready, true, "unproven coverage does not block a build");
  const gx = r.checks.find((c) => c.name === "governed-exec");
  assert.equal(gx?.level, "recommended");
  assert.match(gx?.detail ?? "", /DEGRADED/);
  assert.match(gx?.detail ?? "", /no project manifest/, "it says WHY it could not tell");
});

test("readiness: permitted checks are reported by name", async () => {
  const r = await assessV2Readiness(probe({ gx: { resolved: true, permitted: true, programs: ["pnpm", "node"], denied: [] } }));
  const gx = r.checks.find((c) => c.name === "governed-exec");
  assert.equal(gx?.ok, true);
  assert.match(gx?.detail ?? "", /pnpm, node/);
});

test("readiness: an UNSELECTABLE builder route is a required failure with NO fallback", async () => {
  const r = await assessV2Readiness(probe({ routes: { ok: true, builder: { modelId: "mimo-v2.5", satisfiable: false }, critic: { modelId: "mimo-v2.5-pro", satisfiable: true } } }));
  assert.equal(r.ready, false);
  const builder = r.checks.find((c) => c.name === "builder route");
  assert.equal(builder?.ok, false);
  assert.match(builder?.detail ?? "", /NOT selectable/);
  assert.match(builder?.detail ?? "", /NO fallback/);
  // The render must show the daily-driver header and the NOT-READY verdict.
  const text = renderV2Readiness(r);
  assert.match(text, /V2 DAILY-DRIVER READINESS/);
  assert.match(text, /NOT READY/);
});

// ── the live profile/provider/model mismatch doctor must diagnose, not merely refuse ──

test("readiness: a profile-pinned provider that serves NO route for the model is named exactly", async () => {
  // THE reproduced live failure: the active profile pins `provider: mimo / model: mimo-v2.5-pro`,
  // but the roster re-declared that logical model behind a model-specific provider id, so its
  // only route is through 'mimo-v2.5-pro'. Doctor already refused; what it could not do was say
  // WHY, which sent the investigation into the resolver instead of the roster.
  const r = await assessV2Readiness(probe({
    routes: {
      ok: true,
      builder: {
        modelId: "mimo-v2.5-pro",
        satisfiable: false,
        providerId: "mimo",
        modelInInventory: true,
        providerRegistered: true,
        availableRoutes: ["mimo-v2.5-pro"],
      },
      critic: { modelId: "mimo-v2.5", satisfiable: true },
    },
  }));
  assert.equal(r.ready, false, "an impossible profile/provider/model pairing is NOT READY");
  const builder = r.checks.find((c) => c.name === "builder route");
  assert.equal(builder?.level, "required");
  assert.equal(builder?.ok, false);
  const detail = builder?.detail ?? "";
  assert.match(detail, /builder/, "it names the ROLE");
  assert.match(detail, /'mimo-v2\.5-pro'/, "it names the MODEL");
  assert.match(detail, /pins provider 'mimo'/, "it names the REQUESTED provider");
  assert.match(detail, /declares routes only through 'mimo-v2\.5-pro'/, "it names the AVAILABLE routes");
  assert.match(detail, /NO fallback/, "the no-fallback contract is still stated");
});

test("readiness: a pinned provider that is not registered is diagnosed differently from one with no route", async () => {
  // Two structurally different configurations that the single old sentence conflated.
  const unregistered = await assessV2Readiness(probe({
    routes: {
      ok: true,
      builder: { modelId: "mimo-v2.5-pro", satisfiable: false, providerId: "mimo", modelInInventory: true, providerRegistered: false, availableRoutes: ["mimo-v2.5-pro"] },
      critic: { modelId: "mimo-v2.5", satisfiable: true },
    },
  }));
  assert.match(unregistered.checks.find((c) => c.name === "builder route")?.detail ?? "", /not registered on this machine/);

  const uncredentialed = await assessV2Readiness(probe({
    routes: {
      ok: true,
      builder: { modelId: "mimo-v2.5-pro", satisfiable: false, providerId: "mimo", modelInInventory: true, providerRegistered: true, providerReadiness: "not_configured", availableRoutes: ["mimo"] },
      critic: { modelId: "mimo-v2.5", satisfiable: true },
    },
  }));
  assert.match(uncredentialed.checks.find((c) => c.name === "builder route")?.detail ?? "", /not_configured \(no usable credential\)/);
});

test("readiness: a selectable route reports the provider that will actually serve it", async () => {
  const r = await assessV2Readiness(probe({
    routes: {
      ok: true,
      builder: { modelId: "mimo-v2.5-pro", satisfiable: true, providerId: "mimo", availableRoutes: ["mimo"] },
      critic: { modelId: "mimo-v2.5-pro", satisfiable: true, providerId: "mimo", availableRoutes: ["mimo"] },
    },
  }));
  assert.equal(r.ready, true);
  assert.match(r.checks.find((c) => c.name === "builder route")?.detail ?? "", /selectable via provider 'mimo'/);
});

// ── the builder turn budget ───────────────────────────────────────────────────

test("readiness: the DEFAULT turn budget is not a problem", async () => {
  // Twelve is the shipped bound, not a misconfiguration, and doctor must never imply it is.
  const r = await assessV2Readiness(probe());
  assert.equal(r.ready, true);
  const turns = r.checks.find((c) => c.name === "builder turns");
  assert.equal(turns?.ok, true);
  assert.equal(turns?.level, "recommended");
  assert.match(turns?.detail ?? "", /default 12/);
});

test("readiness: a RAISED turn budget is reported, with the cost warning", async () => {
  const r = await assessV2Readiness(probe({ turns: { ok: true, maxTurns: 24, source: "operator_env" } }));
  assert.equal(r.ready, true, "raising it is lawful, not a readiness failure");
  const turns = r.checks.find((c) => c.name === "builder turns");
  assert.equal(turns?.ok, true);
  assert.match(turns?.detail ?? "", /24/);
  assert.match(turns?.detail ?? "", /cost/i, "an operator who raised it is told what it costs");
});

test("readiness: a MALFORMED turn budget is NOT READY, before anything is spent", async () => {
  /*
    The case an operator cannot otherwise discover without paying for a build to abort:
    the variable is set to something the session will refuse at startup.
  */
  const r = await assessV2Readiness(probe({
    turns: { ok: false, reason: 'IKBI_V2_MAX_BUILDER_TURNS="30junk" is not an integer (expected 1–100)' },
  }));
  assert.equal(r.ready, false);
  const turns = r.checks.find((c) => c.name === "builder turns");
  assert.equal(turns?.level, "required");
  assert.equal(turns?.ok, false);
  assert.match(turns?.detail ?? "", /NOT READY/);
  assert.match(turns?.detail ?? "", /30junk/, "and it quotes the value that will be refused");
});

test("readiness: an unresolved configuration marks BOTH routes as required failures", async () => {
  const r = await assessV2Readiness(probe({ routes: { ok: false, detail: "no providers configured" } }));
  assert.equal(r.ready, false);
  assert.equal(r.checks.filter((c) => c.name.endsWith("route") && !c.ok).length, 2);
});

test("readiness: the CLI exits 0 when ready and 1 when not, and never prints a provider secret", async () => {
  let out = "";
  const okCode = await runV2ReadinessCli([], { stdout: (s) => (out += s), probe: probe() });
  assert.equal(okCode, 0);
  const failCode = await runV2ReadinessCli(["--json"], { stdout: (s) => (out += s), probe: probe({ git: false }) });
  assert.equal(failCode, 1);
  assert.doesNotMatch(out, /sk-|api[_-]?key|password/i, "readiness never renders a secret");
});
