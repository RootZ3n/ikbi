/**
 * RESOLUTION TRUTH, END TO END — REQUIRES `pnpm build`.
 *
 * The hostile test for the defect class this slice eliminates: model selection happening
 * somewhere other than the one authority, or happening on the strength of something
 * other than the operator's recorded configuration.
 *
 * Two providers, two models, two profiles. The operator activates one profile through
 * the REAL `ikbi profile use`, the REAL `ikbi v2 build` binary runs, and the authorized
 * route must be the one that profile asked for — with the requested preference, the
 * selected model, the selected provider, the decision identity and the policy identity
 * all agreeing. Then the profile flips and everything must move together.
 *
 * It fails if profile activation is ignored, if another configuration source re-selects,
 * if a provider fallback overrides an explicit provider pin, if the CLI fabricates a
 * decision, or if preference and inventory are conflated.
 *
 * Nothing is invoked at any point.
 *
 * Capability: subprocess (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { contentDigest } from "../core/identity.js";
import type { V2RunResult } from "../core/result.js";
import { loopbackEgressEnv, startFakeOpenAIProvider } from "./fake-provider-server.js";
import { initGitRepo } from "./fixture-repo.js";

const ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));
/**
 * A small COMMITTED fixture repository. V2-006 allocates a worktree from HEAD and
 * re-observes a context artifact there, so pointing these suites at the ikbi checkout
 * would make them fail whenever the operator has an uncommitted CLAUDE.md — a real
 * behavior, but not what these suites are about.
 */
const REPO = initGitRepo({ "AGENTS.md": "# fixture conventions\nBe terse.\n", "src/widget.ts": "export const widget = 1;\n" });

/** Planted in a provider key and a profile parameter; must never surface. */
const PLANTED_SECRET = "sk-live-RESOLVERMUSTNEVERPRINTTHIS";

const zeroCost = { promptPerMTok: 0, completionPerMTok: 0 };

/**
 * p1 and p2 are keyless and distinguishable. `dry` is registered but has no credential,
 * so it is a real `not_configured` route. `chained` puts `dry` FIRST so route ordering
 * has to skip it rather than merely happening to pick the right one.
 */
// A REAL local endpoint (V2-005): every run here now performs a real HTTP invocation.
const PROVIDER = await startFakeOpenAIProvider();
after(() => PROVIDER.close());

const ROSTER = {
  providers: [
    { id: "p1", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true },
    { id: "p2", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, keyless: true },
    { id: "dry", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl },
    { id: "keyed", kind: "openai-compatible", baseUrl: PROVIDER.baseUrl, apiKey: PLANTED_SECRET },
  ],
  models: [
    // Declared windows so the downstream context budget can be derived from facts.
    { id: "alpha", role: "builder", cost: zeroCost, providers: [{ provider: "p1", providerModelId: "alpha-wire" }], capabilities: { context_window: 100000, supports_tools: true } },
    { id: "beta", role: "builder", cost: zeroCost, providers: [{ provider: "p2", providerModelId: "beta-wire" }], capabilities: { context_window: 100000, supports_tools: true } },
    {
      id: "chained",
      role: "builder",
      cost: zeroCost,
      providers: [
        { provider: "dry", providerModelId: "chained-dry" },
        { provider: "p1", providerModelId: "chained-p1" },
        { provider: "p2", providerModelId: "chained-p2" },
      ],
      capabilities: { context_window: 100000, supports_tools: true },
    },
    { id: "dry-only", role: "builder", cost: zeroCost, providers: [{ provider: "dry", providerModelId: "dry-wire" }], capabilities: { context_window: 100000, supports_tools: true } },
  ],
};

const roleProfile = (name: string, provider: string, model: string, extra: Record<string, unknown> = {}) => ({
  name,
  roles: { builder: { provider, model }, critic: { provider, model } },
  ...extra,
});

const roots: string[] = [];

function makeStateRoot(roster: unknown = ROSTER): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-resolve-"));
  roots.push(root);
  mkdirSync(join(root, "profiles"), { recursive: true });
  writeFileSync(join(root, "providers.json"), JSON.stringify(roster, null, 2));
  writeProfile(root, roleProfile("prof-a", "p1", "alpha"));
  writeProfile(root, roleProfile("prof-b", "p2", "beta"));
  writeProfile(root, roleProfile("prof-dry", "dry", "dry-only"));
  return root;
}

function writeProfile(root: string, doc: Record<string, unknown>): void {
  writeFileSync(join(root, "profiles", `${String(doc.name)}.json`), JSON.stringify(doc, null, 2));
}

/** Run the built CLI. NOTE: no IKBI_MODEL_* is exported unless a test asks for one. */
function runCli(root: string, args: readonly string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-v2-resolve-cwd-")),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: mkdtempSync(join(tmpdir(), "ikbi-v2-resolve-home-")),
      IKBI_STATE_ROOT: root,
      ...loopbackEgressEnv(PROVIDER),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function v2Run(root: string, args: readonly string[] = [], extraEnv: Record<string, string> = {}) {
  const r = runCli(root, ["v2", "build", "a resolution probe", "--repo", REPO, "--json", ...args], extraEnv);
  assert.ok(r.stdout.trim().startsWith("{"), `expected JSON on stdout, got:\n${r.stdout}\n---\n${r.stderr}`);
  return { result: JSON.parse(r.stdout) as V2RunResult, stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const activate = (root: string, name: string): void => {
  const r = runCli(root, ["profile", "use", name]);
  assert.equal(r.status, 0, `activating ${name} failed:\n${r.stdout}\n${r.stderr}`);
};

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("resolution truth: the built CLI exists (run `pnpm build` first)", () => {
  assert.ok(existsSync(ENTRY), `built CLI not found at ${ENTRY}`);
});

// ── THE hostile test ────────────────────────────────────────────────────────

test("resolution truth: the operator's profile decides the authorized route, end to end", () => {
  const root = makeStateRoot();

  activate(root, "prof-a");
  const a = v2Run(root).result;
  assert.equal(a.receipt.configuration?.profile, "prof-a");
  assert.equal(a.decision?.modelId, "alpha");
  assert.equal(a.decision?.providerId, "p1");
  assert.equal(a.decision?.providerModelId, "alpha-wire");
  assert.equal(a.decision?.providerConstraint, "explicit");
  assert.equal(a.decision?.preferenceSource, "active_profile");

  activate(root, "prof-b");
  const b = v2Run(root).result;
  assert.equal(b.receipt.configuration?.profile, "prof-b");
  assert.equal(b.decision?.modelId, "beta");
  assert.equal(b.decision?.providerId, "p2");
  assert.equal(b.decision?.providerModelId, "beta-wire");

  // Everything agrees, and everything moved together.
  assert.notEqual(a.decision?.decisionId, b.decision?.decisionId);
  assert.notEqual(a.receipt.configuration?.policyId, b.receipt.configuration?.policyId);
  // And the machine's capabilities never changed — only the operator's strategy did.
  assert.equal(a.receipt.configuration?.inventoryDigest, b.receipt.configuration?.inventoryDigest);
});

test("resolution truth: the decision is BOUND to the policy the run actually recorded", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  const { result } = v2Run(root);
  assert.equal(result.decision?.policyId, result.receipt.configuration?.policyId);
  assert.equal(result.decision?.policyId, result.policy?.policyId);
  assert.equal(result.decision?.runId, result.runId);
});

test("resolution truth: the CLI cannot FABRICATE a decision id — it recomputes exactly", () => {
  // Independently recompute the content address from the decision's own semantic fields.
  // A CLI that invented an id, or resolved by some other path, cannot survive this.
  const root = makeStateRoot();
  activate(root, "prof-a");
  const d = v2Run(root).result.decision!;
  const recomputed = contentDigest("decision", {
    policyId: d.policyId,
    role: d.role,
    modelId: d.modelId,
    providerId: d.providerId,
    providerModelId: d.providerModelId,
    preferenceSource: d.preferenceSource,
    providerConstraint: d.providerConstraint,
    requirements: d.requirements,
  });
  assert.equal(d.decisionId, recomputed, "the published id is the content address of the published selection");
});

test("resolution truth: identical configuration reproduces the identical decision id", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  assert.equal(v2Run(root).result.decision?.decisionId, v2Run(root).result.decision?.decisionId);
});

// ── constraint and route policy ─────────────────────────────────────────────

test("resolution truth: an explicit provider pin that is NOT configured fails — no substitution", () => {
  const root = makeStateRoot();
  // `prof-dry` pins the `dry` provider, which is registered but has no credential.
  // `ikbi profile use` accepts it (registration is all v1 checks); the RESOLVER refuses.
  activate(root, "prof-dry");
  const { result, status } = v2Run(root);
  assert.notEqual(status, 0);
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.category, "resolution");
  assert.equal(result.outcome.failure.code, "resolution.provider_not_selectable");
  assert.equal(result.decision, undefined, "no route was authorized");
  assert.equal(result.receipt.resolution, undefined, "and none was receipted");
  assert.equal(result.receipt.evidence.modelResolutionCompleted, false);
  // `alpha`/`beta` are perfectly usable through p1/p2 and are visible in the inventory.
  // The refusal must not reach for them, and must not even name one as a way out.
  const message = result.outcome.failure.message;
  for (const alternative of ["p1", "p2", "alpha", "beta"]) {
    assert.equal(message.includes(alternative), false, `the refusal suggested "${alternative}" as a substitute`);
  }
});

test("resolution truth: a model-only preference walks the declared chain deterministically", () => {
  const root = makeStateRoot();
  // No profile; the operator names only a MODEL through the configuration layer. The
  // chain starts with an unusable provider, so ordering has to actually be applied.
  const { result } = v2Run(root, [], { IKBI_MODEL_BUILDER: "chained" });
  assert.equal(result.decision?.modelId, "chained");
  assert.equal(result.decision?.providerId, "p1", "dry is skipped; p1 is next in the DECLARED order");
  assert.equal(result.decision?.providerModelId, "chained-p1");
  assert.equal(result.decision?.routeOrdinal, 1);
  assert.equal(result.decision?.basis, "first_selectable_route");
  assert.equal(result.decision?.providerConstraint, "unconstrained");
  assert.equal(result.decision?.preferenceSource, "operator_env");
});

test("resolution truth: a not_configured route is never selected, even as a last resort", () => {
  const root = makeStateRoot();
  const { result } = v2Run(root, [], { IKBI_MODEL_BUILDER: "dry-only" });
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "resolution.no_selectable_route");
  assert.match(result.outcome.failure.message, /dry=not_configured/);
});

test("resolution truth: a model absent from the inventory fails rather than defaulting", () => {
  const root = makeStateRoot();
  const { result } = v2Run(root, [], { IKBI_MODEL_BUILDER: "not-a-real-model" });
  assert.ok(result.outcome.kind === "failed");
  assert.equal(result.outcome.failure.code, "resolution.model_not_in_inventory");
});

// ── inventory independence, through the real binary ─────────────────────────

test("inventory independence: a PREFERENCE cannot invent or rename an inventory model", () => {
  const root = makeStateRoot();
  const base = v2Run(root).result.policy!;
  const preferred = v2Run(root, [], { IKBI_MODEL_DRIVER: "totally-made-up", IKBI_MODEL_CRITIC: "another-invention" }).result.policy!;

  assert.deepEqual(
    preferred.inventory.models.map((m) => m.id).sort(),
    base.inventory.models.map((m) => m.id).sort(),
    "inventory membership is a property of the machine, not of what the operator prefers",
  );
  assert.equal(
    preferred.inventory.models.some((m) => m.id === "totally-made-up"),
    false,
    "v1 would have minted this model out of a preference; v2 does not",
  );
});

test("inventory independence: changing the PROFILE alone does not move the inventory digest", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  const a = v2Run(root).result.receipt.configuration!;
  activate(root, "prof-b");
  const b = v2Run(root).result.receipt.configuration!;
  assert.equal(a.inventoryDigest, b.inventoryDigest);
  assert.notEqual(a.policyId, b.policyId, "the strategy moved; the machine did not");
});

test("inventory independence: changing IKBI_MODEL_* alone does not move the inventory digest", () => {
  const root = makeStateRoot();
  const base = v2Run(root).result.receipt.configuration!;
  const preferred = v2Run(root, [], { IKBI_MODEL_DRIVER: "totally-made-up" }).result.receipt.configuration!;
  assert.equal(base.inventoryDigest, preferred.inventoryDigest);
});

test("inventory independence: changing the REAL roster DOES move the inventory digest", () => {
  const base = v2Run(makeStateRoot()).result.receipt.configuration!;
  const extendedRoster = {
    ...ROSTER,
    models: [...ROSTER.models, { id: "gamma", role: "builder", cost: zeroCost, providers: [{ provider: "p1", providerModelId: "gamma-wire" }] }],
  };
  const extended = v2Run(makeStateRoot(extendedRoster)).result.receipt.configuration!;
  assert.notEqual(base.inventoryDigest, extended.inventoryDigest, "a real capability change must be visible");
});

// ── boundaries this slice must not cross ────────────────────────────────────

test("resolution truth: model_resolution is ENTERED, and the run adjudicates through to disposition", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  const { result } = v2Run(root);
  assert.deepEqual(result.receipt.stagesEntered, ["preflight", "model_resolution", "context", "candidate_strategy", "candidate_generation", "verification", "criticism", "disposition"]);
  assert.ok(result.outcome.kind === "withheld", "the candidate is adjudicated and withheld — nothing promoted");
  assert.equal(result.receipt.stagesEntered.includes("promotion"), false, "and the run stops before promotion");
});

test("resolution truth: builder AND critic decisions are recorded, one invocation each", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  const { result } = v2Run(root);
  assert.equal(result.receipt.evidence.modelResolutions, 2, "V2-009: builder and critic roles each resolved once");
  assert.equal(result.receipt.evidence.modelResolutionCompleted, true);
  assert.equal(result.receipt.evidence.providerInvoked, true, "the authorized routes were really called");
  assert.equal(result.receipt.evidence.invocations, 2, "the builder's finish turn AND the critic's judgment");
  assert.equal(result.receipt.evidence.candidatesCreated, 1, "the builder finished — the candidate is unverified, not absent");
  assert.equal(result.receipt.evidence.sourceRepositoryMutated, false);
});

test("resolution truth: the repository is untouched by a resolving run", () => {
  const root = makeStateRoot();
  activate(root, "prof-a");
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout;
  v2Run(root);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).stdout, before);
});

// ── secrets ─────────────────────────────────────────────────────────────────

test("resolution truth: no credential appears in output, the decision, or its identity", () => {
  const root = makeStateRoot();
  writeProfile(root, roleProfile("prof-a", "p1", "alpha", { parameters: { API_KEY: PLANTED_SECRET } }));
  activate(root, "prof-a");
  const { result, stdout, stderr } = v2Run(root);
  for (const [what, text] of [["stdout", stdout], ["stderr", stderr], ["result", JSON.stringify(result)]] as const) {
    assert.equal(text.includes(PLANTED_SECRET), false, `the planted key leaked into ${what}`);
  }
  const human = runCli(root, ["v2", "build", "probe", "--repo", REPO]);
  assert.equal(human.stdout.includes(PLANTED_SECRET), false);
  assert.equal(human.stderr.includes(PLANTED_SECRET), false);
  assert.equal(
    Object.keys(result.decision ?? {}).some((k) => /key|secret|token|credential/i.test(k)),
    false,
    "the decision has no credential-shaped field at all",
  );
});
