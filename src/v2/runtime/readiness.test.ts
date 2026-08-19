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
  routes: Awaited<ReturnType<V2ReadinessProbe["routes"]>>;
}> = {}): V2ReadinessProbe {
  return {
    git: () => over.git ?? true,
    bwrap: () => over.bwrap ?? true,
    governedExecChecks: () => over.gx ?? { resolved: true, permitted: true, programs: ["pnpm"], denied: [] },
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
