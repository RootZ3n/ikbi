import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Side-effect FIRST (mirrors the CLI's barrel-first boot): egress registers the fetch
// guard, so importing doctor.js — which imports the provider registry singleton, whose
// construction resolves that guard — does not fail closed at module load.
import "../modules/egress/index.js";

import { loadConfig } from "../core/config.js";
import type { ModelProvider } from "../core/provider/contract.js";
import { detectPackageManager, envTemplate, runDoctor, runDoctorFix, type DoctorFixPorts, type DoctorInputs, type DoctorRegistry } from "./doctor.js";

/**
 * A fake read-only registry. `models` maps a model id → its provider-route chain;
 * `registered` is the set of provider ids that are actually declared. A model
 * "resolves" iff it exists AND some route's provider is registered.
 */
function fakeRegistry(models: Record<string, string[]>, registered: string[]): DoctorRegistry {
  const provs = new Set(registered);
  return {
    getModel: (id) => (models[id] ? { id, providers: models[id].map((p) => ({ provider: p, providerModelId: id })) } : undefined),
    getProvider: (id) => (provs.has(id) ? ({ id } as unknown as ModelProvider) : undefined),
  };
}

const DEV_ENV = { IKBI_ALLOW_INSECURE_DEV_KEYS: "true" } as const;

/** The default role models (loadConfig defaults) both resolve to a roster-declared provider. */
const resolvingRegistry = (): DoctorRegistry => fakeRegistry({ "mimo-v2.5": ["mimo"], "deepseek-v4-pro": ["deepseek"] }, ["mimo", "deepseek"]);
/** Nothing resolves (no models / no registered providers). */
const emptyRegistry = (): DoctorRegistry => fakeRegistry({}, []);

/** A config + module-config set with EVERYTHING required satisfied (the ready case). */
function readyInputs(over: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    config: loadConfig({
      IKBI_OPERATOR_TOKEN: "op-secret-strong-value",
      IKBI_WORKER_TOKEN: "worker-secret-strong-value",
      IKBI_TRUST_HMAC_KEY: "a-real-hmac-key",
      IKBI_IDENTITY_TOKEN_SALT: "a-real-salt",
    }),
    workerModelEnabled: true,
    governedExecAllowlist: ["git", "pnpm"],
    egressAllowlist: ["api.mimo.example"],
    egressLocalEndpoints: [],
    registry: resolvingRegistry(),
    ...over,
  };
}

test("doctor REPORTS MISSING required settings and ends NOT ready (cold start)", () => {
  const r = runDoctor({
    config: loadConfig(DEV_ENV), // no build credentials set; dev key opt-in only lets config load
    workerModelEnabled: false,
    governedExecAllowlist: ["git", "ls"], // no pnpm
    egressAllowlist: [],
    egressLocalEndpoints: [],
    registry: emptyRegistry(), // no role model resolves
  });
  assert.equal(r.ready, false);
  assert.equal(r.missingRequired, 5, "all five required-for-build settings are missing");
  const text = r.lines.join("\n");
  assert.match(text, /✗ IKBI_OPERATOR_TOKEN/);
  assert.match(text, /✗ IKBI_WORKER_TOKEN/);
  assert.match(text, /✗ IKBI_WORKER_MODEL_ENABLED/);
  assert.match(text, /export IKBI_WORKER_MODEL_ENABLED=true/);
  assert.match(text, /✗ IKBI_GOVERNED_EXEC_ALLOWLIST/);
  assert.match(text, /✗ the driver model 'mimo-v2.5' and builder model 'mimo-v2.5' and critic model 'deepseek-v4-pro' don't resolve to a registered provider/);
  assert.match(text, /NOT ready — 5 required settings missing/);
});

test("ROSTER PROVIDER SEEN: role models resolving via a roster provider (no env key) ⇒ ✓ provider, ready (the MiMo smoke case)", () => {
  // The EXACT bug: no IKBI_MIMO_API_KEY env, but mimo-v2.5 / mimo-v2.5-pro resolve to a
  // roster-DECLARED keyless+api-key provider. The old env-key check falsely failed this.
  const r = runDoctor(
    readyInputs({
      config: loadConfig({ IKBI_OPERATOR_TOKEN: "op-strong-value-here", IKBI_WORKER_TOKEN: "worker-strong-value-here", IKBI_TRUST_HMAC_KEY: "h", IKBI_IDENTITY_TOKEN_SALT: "s" }),
      registry: fakeRegistry({ "mimo-v2.5": ["mimo", "deepseek"], "deepseek-v4-pro": ["deepseek"] }, ["mimo", "deepseek"]),
    }),
  );
  const text = r.lines.join("\n");
  assert.match(text, /✓ provider — all role models resolve \(driver 'mimo-v2.5', builder 'mimo-v2.5', critic 'deepseek-v4-pro'\)/);
  assert.equal(r.ready, true, "a roster setup that just ran a build is correctly reported ready");
});

test("BUILT-IN KEY STILL WORKS: models resolving via a built-in keyed provider ⇒ ✓ (regression)", () => {
  const r = runDoctor(readyInputs({ registry: fakeRegistry({ "mimo-v2.5": ["mimo"], "deepseek-v4-pro": ["deepseek"] }, ["mimo", "openrouter", "deepseek"]) }));
  assert.match(r.lines.join("\n"), /✓ provider — all role models resolve/);
  assert.equal(r.ready, true);
});

test("UNRESOLVABLE MODEL FLAGGED: a driver model with no registered provider ⇒ ✗ + actionable message, NOT ready", () => {
  const r = runDoctor(
    readyInputs({
      // driver model declared but its provider isn't registered; critic resolves.
      registry: fakeRegistry({ "mimo-v2.5": ["ghost"], "deepseek-v4-pro": ["deepseek"] }, ["mimo", "deepseek"]),
    }),
  );
  const text = r.lines.join("\n");
  assert.match(text, /✗ the driver model 'mimo-v2.5' and builder model 'mimo-v2.5' don't resolve to a registered provider — add a provider entry/);
  assert.equal(r.ready, false);
  assert.match(text, /NOT ready — 1 required setting missing/);
});

test("WHICH MODEL FLAGGED: driver resolves but critic doesn't ⇒ the CRITIC model is named specifically", () => {
  const r = runDoctor(
    readyInputs({
      registry: fakeRegistry({ "mimo-v2.5": ["mimo"] /* critic absent entirely */ }, ["mimo"]),
    }),
  );
  const text = r.lines.join("\n");
  assert.match(text, /✗ the critic model 'deepseek-v4-pro' doesn't resolve to a registered provider/);
  assert.doesNotMatch(text, /driver model 'mimo-v2.5' (?:and|doesn't)/, "the resolving driver is NOT flagged");
  assert.equal(r.ready, false);
});

test("INJECTABLE REGISTRY: doctor uses the fake registry passed in (not the real singleton)", () => {
  // A registry that resolves a NONSENSE model id only — proving doctor consulted THIS registry.
  let getModelCalls = 0;
  const spy: DoctorRegistry = {
    getModel: (id) => {
      getModelCalls += 1;
      return id === "mimo-v2.5" || id === "deepseek-v4-pro" ? { id, providers: [{ provider: "p", providerModelId: id }] } : undefined;
    },
    getProvider: (id) => (id === "p" ? ({ id } as unknown as ModelProvider) : undefined),
  };
  const r = runDoctor(readyInputs({ registry: spy }));
  assert.ok(getModelCalls >= 2, "doctor queried the injected registry for the driver + critic models");
  assert.equal(r.ready, true);
});

test("doctor WARNS on insecure default keys when the dev opt-in IS set (⚠), still ready", () => {
  const r = runDoctor({
    // default keys, but explicitly opted into dev keys → warning, not a blocker.
    config: loadConfig({ IKBI_OPERATOR_TOKEN: "op-strong-value-here", IKBI_WORKER_TOKEN: "worker-strong-value-here", IKBI_ALLOW_INSECURE_DEV_KEYS: "true" }),
    workerModelEnabled: true,
    governedExecAllowlist: ["pnpm"],
    registry: resolvingRegistry(),
  });
  const text = r.lines.join("\n");
  assert.match(text, /⚠ IKBI_TRUST_HMAC_KEY .* explicitly allowed via IKBI_ALLOW_INSECURE_DEV_KEYS/, "insecure trust key flagged as an allowed dev warning");
  assert.match(text, /⚠ IKBI_IDENTITY_TOKEN_SALT .* explicitly allowed via IKBI_ALLOW_INSECURE_DEV_KEYS/, "insecure token salt flagged as an allowed dev warning");
  assert.equal(r.ready, true, "explicitly-allowed dev keys are a warning, not a build-blocker");
});

test("doctor BLOCKS (✗) on insecure default keys when the dev opt-in is NOT set, NOT ready", () => {
  // The startup gate fires first in a LIVE process; here we construct the unopted-in
  // default-keys config doctor would inspect (loadConfig past the gate via the dev flag,
  // then drop the flag) to prove doctor reports it as the refuse-to-start blocker it is.
  const base = loadConfig({ IKBI_OPERATOR_TOKEN: "op-strong-value-here", IKBI_WORKER_TOKEN: "worker-strong-value-here", IKBI_ALLOW_INSECURE_DEV_KEYS: "true" });
  const cfg = { ...base, allowInsecureDevKeys: false };
  const r = runDoctor({
    config: cfg,
    workerModelEnabled: true,
    governedExecAllowlist: ["pnpm"],
    registry: resolvingRegistry(),
  });
  const text = r.lines.join("\n");
  assert.match(text, /✗ IKBI_TRUST_HMAC_KEY .* refuse to start/, "insecure trust key is a refuse-to-start blocker");
  assert.match(text, /✗ IKBI_IDENTITY_TOKEN_SALT .* refuse to start/, "insecure token salt is a refuse-to-start blocker");
  assert.match(text, /NOT ready — .*insecure default key/, "the summary names the security blocker");
  assert.equal(r.ready, false, "default keys with no dev opt-in is a build blocker");
});

test("doctor PRINTS NO SECRET VALUES — only set/unset status", () => {
  const r = runDoctor(
    readyInputs({
      config: loadConfig({
        IKBI_OPERATOR_TOKEN: "SUPER-SECRET-OP",
        IKBI_WORKER_TOKEN: "SUPER-SECRET-WORKER",
        IKBI_TRUST_HMAC_KEY: "SUPER-SECRET-HMAC",
        IKBI_IDENTITY_TOKEN_SALT: "SUPER-SECRET-SALT",
        IKBI_MIMO_API_KEY: "SUPER-SECRET-APIKEY",
      }),
    }),
  );
  const text = r.lines.join("\n");
  for (const secret of ["SUPER-SECRET-OP", "SUPER-SECRET-WORKER", "SUPER-SECRET-HMAC", "SUPER-SECRET-SALT", "SUPER-SECRET-APIKEY"]) {
    assert.equal(text.includes(secret), false, `doctor output must not contain the secret value "${secret}"`);
  }
  assert.match(text, /✓ IKBI_OPERATOR_TOKEN/);
  assert.match(text, /✓ IKBI_WORKER_TOKEN/);
});

test("doctor SHOWS the resolved role models — driver, builder, critic (so the operator sees which models will be used)", () => {
  const r = runDoctor({
    config: loadConfig({ ...DEV_ENV, IKBI_MODEL_DRIVER: "qwen3:4b", IKBI_MODEL_BUILDER: "deepseek-v4-pro", IKBI_MODEL_CRITIC: "qwen3:14b" }),
    registry: fakeRegistry({ "qwen3:4b": ["x"], "deepseek-v4-pro": ["x"], "qwen3:14b": ["x"] }, ["x"]),
  });
  const text = r.lines.join("\n");
  assert.match(text, /IKBI_MODEL_DRIVER\s+= qwen3:4b/);
  assert.match(text, /IKBI_MODEL_BUILDER = deepseek-v4-pro/);
  assert.match(text, /IKBI_MODEL_CRITIC\s+= qwen3:14b/);
});

test("doctor SHOWS the competitive shootout list and resolution-CHECKS each racer by name", () => {
  // A competitive model that does NOT resolve to a provider is flagged BY NAME (critical
  // for the shootout — the operator must know if a racer isn't wired).
  const r = runDoctor(
    readyInputs({
      config: loadConfig({ IKBI_OPERATOR_TOKEN: "op-strong-value-here", IKBI_WORKER_TOKEN: "worker-strong-value-here", IKBI_TRUST_HMAC_KEY: "h", IKBI_IDENTITY_TOKEN_SALT: "s", IKBI_COMPETITIVE_MODELS: "mimo-v2.5, qwen3:14b" }),
      // mimo-v2.5 resolves; qwen3:14b is NOT registered → flagged.
      registry: fakeRegistry({ "mimo-v2.5": ["mimo", "deepseek"], "deepseek-v4-pro": ["deepseek"] }, ["mimo", "deepseek"]),
    }),
  );
  const text = r.lines.join("\n");
  assert.match(text, /IKBI_COMPETITIVE_MODELS = mimo-v2\.5, qwen3:14b/, "the shootout list is shown");
  assert.match(text, /✗ the competitive model 'qwen3:14b' doesn't resolve to a registered provider/, "the unwired racer is flagged by name");
  assert.equal(r.ready, false, "an unresolvable competitive racer blocks readiness");
});

// ── SAFETY POSTURE: verification + retrieval mode reporting (the hardening patch) ────────────

test("F3/F4: doctor REPORTS the verification + retrieval modes (HARDENED by default, no env)", () => {
  const r = runDoctor(readyInputs({ env: {} }));
  const text = r.lines.join("\n");
  assert.match(text, /SAFETY POSTURE/);
  assert.match(text, /✓ Verification: ladder \(HARDENED/, "F3: verification mode reported as the hardened ladder default");
  assert.match(text, /✓ Retrieval: index \(HARDENED/, "F4: retrieval mode reported as the hardened index default");
  assert.match(text, /✓ Posture: HARDENED/, "the combined posture is HARDENED");
  assert.equal(r.ready, true, "a hardened default config is still ready");
});

test("F5: doctor WARNS when verification is legacy (hardened protections disabled)", () => {
  const r = runDoctor(readyInputs({ env: { IKBI_VERIFY: "legacy" } }));
  const text = r.lines.join("\n");
  assert.match(text, /⚠ Verification: legacy/, "the legacy verification path is flagged with a warning glyph");
  assert.match(text, /verification is LEGACY — hardened ladder protections are DISABLED \(IKBI_VERIFY=legacy set\)/);
  assert.match(text, /⚠ Posture: MIXED/, "one legacy + one hardened ⇒ MIXED posture");
  assert.match(text, /opted OUT of a hardened path/, "an explicit legacy default is surfaced as an opt-out");
});

test("F5: doctor WARNS when retrieval is legacy, and reports LEGACY posture when BOTH are legacy", () => {
  const mixed = runDoctor(readyInputs({ env: { IKBI_RETRIEVAL: "legacy" } }));
  assert.match(mixed.lines.join("\n"), /⚠ Retrieval: legacy/);
  assert.match(mixed.lines.join("\n"), /retrieval is LEGACY — index retrieval is DISABLED \(IKBI_RETRIEVAL=legacy set\)/);

  const both = runDoctor(readyInputs({ env: { IKBI_VERIFY: "legacy", IKBI_RETRIEVAL: "legacy" } }));
  const text = both.lines.join("\n");
  assert.match(text, /⚠ Posture: LEGACY/, "both legacy ⇒ LEGACY posture");
  assert.match(text, /⚠ Verification: legacy/);
  assert.match(text, /⚠ Retrieval: legacy/);
});

test("doctor SAFETY POSTURE honors an explicit hardened opt-in (IKBI_VERIFY=ladder, IKBI_RETRIEVAL=index)", () => {
  const r = runDoctor(readyInputs({ env: { IKBI_VERIFY: "ladder", IKBI_RETRIEVAL: "index" } }));
  assert.match(r.lines.join("\n"), /✓ Posture: HARDENED/);
});

// ── doctor --fix: automatic repair of common gaps ────────────────────────────

/** A config with deterministic state paths (so tests can name the dirs --fix should create). */
function fixConfig() {
  return loadConfig({ IKBI_ALLOW_INSECURE_DEV_KEYS: "true", IKBI_STATE_ROOT: "/tmp/doctorfix-state" });
}

/** Records every side effect the fix ports are asked to perform. */
interface FixEffects {
  writes: Array<{ path: string; content: string }>;
  mkdirs: string[];
  installs: Array<{ manager: string; root: string }>;
  cleans: Array<{ force: boolean }>;
}

/**
 * Build fake fix ports over a set of EXISTING paths. Anything not in `existing` is treated as
 * missing (so its repair fires). Side effects are recorded in the returned `effects`. By default
 * repairs SUCCEED; pass overrides to simulate failure / stale workspaces.
 */
function fakeFixPorts(
  existing: Iterable<string>,
  over: Partial<Pick<DoctorFixPorts, "detectManager" | "install" | "countStaleWorkspaces" | "cleanWorkspaces">> = {},
): { ports: DoctorFixPorts; effects: FixEffects } {
  const have = new Set(existing);
  const effects: FixEffects = { writes: [], mkdirs: [], installs: [], cleans: [] };
  const ports: DoctorFixPorts = {
    exists: (p) => have.has(p),
    mkdirp: async (p) => {
      effects.mkdirs.push(p);
      have.add(p);
    },
    writeFile: async (p, content) => {
      effects.writes.push({ path: p, content });
      have.add(p);
    },
    detectManager: over.detectManager ?? (() => "pnpm"),
    install:
      over.install ??
      (async (manager, root) => {
        effects.installs.push({ manager, root });
        return { ok: true, detail: "" };
      }),
    countStaleWorkspaces: over.countStaleWorkspaces ?? (async () => 0),
    cleanWorkspaces:
      over.cleanWorkspaces ??
      (async ({ force }) => {
        effects.cleans.push({ force });
        return { removed: 0, skipped: 0 };
      }),
  };
  return { ports, effects };
}

/** All paths --fix inspects, so a test can declare "everything is healthy". */
function allHealthyPaths(cfg = fixConfig(), projectRoot = "/proj"): string[] {
  return [`${projectRoot}/.env`, `${projectRoot}/node_modules`, cfg.stateRoot, cfg.trust.dir, cfg.workspace.root];
}

test("doctor --fix CREATES a missing state directory (mkdir -p), leaving present paths alone", async () => {
  const cfg = fixConfig();
  // env + node_modules present; the three state dirs are MISSING.
  const { ports, effects } = fakeFixPorts(["/proj/.env", "/proj/node_modules"]);
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj" });

  assert.deepEqual([...effects.mkdirs].sort(), [cfg.stateRoot, cfg.trust.dir, cfg.workspace.root].sort());
  assert.equal(effects.writes.length, 0, "an existing .env is NOT rewritten");
  assert.equal(effects.installs.length, 0, "existing node_modules is NOT reinstalled");
  const text = r.lines.join("\n");
  assert.match(text, /creating state root \(mkdir -p\)/);
  assert.match(text, /✓ created state root/);
  assert.equal(r.failures, 0);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix CREATES a .env template when none exists — secrets stay COMMENTED (bootstrap forbids them in a cwd .env)", async () => {
  const cfg = fixConfig();
  // everything present EXCEPT the .env.
  const { ports, effects } = fakeFixPorts([cfg.stateRoot, cfg.trust.dir, cfg.workspace.root, "/proj/node_modules"]);
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj" });

  assert.equal(effects.writes.length, 1, "exactly one file written — the .env template");
  assert.equal(effects.writes[0]?.path, "/proj/.env");
  const content = effects.writes[0]?.content ?? "";
  assert.match(content, /^IKBI_WORKER_MODEL_ENABLED=true$/m, "a safe build flag is set live");
  // The four bootstrap-forbidden secret keys must appear ONLY as commented guidance, never as live assignments.
  for (const key of ["IKBI_OPERATOR_TOKEN", "IKBI_WORKER_TOKEN", "IKBI_TRUST_HMAC_KEY", "IKBI_IDENTITY_TOKEN_SALT"]) {
    assert.doesNotMatch(content, new RegExp(`^${key}=`, "m"), `${key} must NOT be a live assignment in a project .env`);
    assert.match(content, new RegExp(`#.*${key}`), `${key} must appear as commented guidance`);
  }
  assert.match(r.lines.join("\n"), /✓ created .env template/);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix WITHOUT --force is NON-DESTRUCTIVE — it REPORTS stale workspaces but never reclaims them", async () => {
  const cfg = fixConfig();
  const { ports, effects } = fakeFixPorts(allHealthyPaths(cfg), { countStaleWorkspaces: async () => 2 });
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj" }); // force defaults to false

  assert.equal(effects.cleans.length, 0, "cleanWorkspaces must NOT be called without --force");
  assert.match(r.lines.join("\n"), /2 stale workspace\(s\) can be reclaimed.*--force/);
  assert.equal(r.failures, 0);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix --force RECLAIMS stale workspaces (the destructive path, gated behind --force)", async () => {
  const cfg = fixConfig();
  const cleanCalls: Array<{ force: boolean }> = [];
  const { ports } = fakeFixPorts(allHealthyPaths(cfg), {
    countStaleWorkspaces: async () => 3,
    cleanWorkspaces: async ({ force }) => {
      cleanCalls.push({ force });
      return { removed: 3, skipped: 0 };
    },
  });
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj", force: true });

  assert.deepEqual(cleanCalls, [{ force: true }], "force passed through to cleanWorkspaces");
  assert.match(r.lines.join("\n"), /✓ reclaimed 3 stale workspace\(s\)/);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix is a NO-OP when everything is healthy (no repairs attempted, exit 0)", async () => {
  const cfg = fixConfig();
  const { ports, effects } = fakeFixPorts(allHealthyPaths(cfg));
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj" });

  assert.equal(r.attempted, 0, "nothing was missing, so nothing was repaired");
  assert.deepEqual(effects, { writes: [], mkdirs: [], installs: [], cleans: [] }, "no side effects on a healthy tree");
  assert.match(r.lines.join("\n"), /nothing to repair — all checks healthy/);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix emits a copy-pasteable FIRST BUILD line for a registered repo", async () => {
  const cfg = fixConfig();
  const { ports } = fakeFixPorts(allHealthyPaths(cfg));
  const r = await runDoctorFix(ports, {
    config: cfg,
    projectRoot: "/proj",
    repoLister: { list: () => [{ name: "toba", path: "/repos/toba" }, { name: "ikbi", path: "/repos/ikbi" }] },
  });
  const text = r.lines.join("\n");
  assert.match(text, /FIRST BUILD/);
  assert.match(text, /ikbi build ".*" --repo toba/);
  assert.match(text, /or any of: toba, ikbi/);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix FIRST BUILD falls back to guidance when no repos are registered", async () => {
  const cfg = fixConfig();
  const { ports } = fakeFixPorts(allHealthyPaths(cfg));
  const r = await runDoctorFix(ports, {
    config: cfg,
    projectRoot: "/proj",
    repoLister: { list: () => [] },
  });
  const text = r.lines.join("\n");
  assert.match(text, /no repos registered yet/);
  assert.match(text, /--repo \/absolute\/path\/to\/your\/repo/);
});

test("doctor --fix RUNS the detected package manager install for missing node_modules", async () => {
  const cfg = fixConfig();
  // node_modules MISSING; everything else present. Manager detected as npm.
  const { ports, effects } = fakeFixPorts([cfg.stateRoot, cfg.trust.dir, cfg.workspace.root, "/proj/.env"], { detectManager: () => "npm" });
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj" });

  assert.deepEqual(effects.installs, [{ manager: "npm", root: "/proj" }]);
  assert.match(r.lines.join("\n"), /running `npm install`/);
  assert.equal(r.exitCode, 0);
});

test("doctor --fix returns exit 1 when a repair FAILS (install error surfaces, non-zero exit)", async () => {
  const cfg = fixConfig();
  const { ports } = fakeFixPorts([cfg.stateRoot, cfg.trust.dir, cfg.workspace.root, "/proj/.env"], {
    detectManager: () => "pnpm",
    install: async () => ({ ok: false, detail: "registry unreachable" }),
  });
  const r = await runDoctorFix(ports, { config: cfg, projectRoot: "/proj" });

  assert.equal(r.failures, 1);
  assert.equal(r.exitCode, 1);
  const text = r.lines.join("\n");
  assert.match(text, /✗ pnpm install failed: registry unreachable/);
  assert.match(text, /✗ doctor --fix: 1 of 1 repair\(s\) FAILED/);
});

test("doctor --fix reports a FAILED mkdir as ✗ and exits 1 (error path is per-repair, not fatal)", async () => {
  const cfg = fixConfig();
  const { ports } = fakeFixPorts(["/proj/.env", "/proj/node_modules"]);
  // Make the first mkdir throw; the run must still finish and report the failure.
  const failingPorts: DoctorFixPorts = {
    ...ports,
    mkdirp: async () => {
      throw new Error("permission denied");
    },
  };
  const r = await runDoctorFix(failingPorts, { config: cfg, projectRoot: "/proj" });

  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /✗ failed to create state root: permission denied/);
});

test("detectPackageManager picks pnpm/npm/yarn from the lockfile, defaulting to pnpm", () => {
  const has = (name: string) => (p: string) => p.endsWith(name);
  assert.equal(detectPackageManager("/r", has("pnpm-lock.yaml")), "pnpm");
  assert.equal(detectPackageManager("/r", has("package-lock.json")), "npm");
  assert.equal(detectPackageManager("/r", has("yarn.lock")), "yarn");
  assert.equal(detectPackageManager("/r", () => false), "pnpm", "no lockfile ⇒ ikbi's default pnpm");
});

test("envTemplate is SAFE for a project .env — no bootstrap-forbidden secret key is a live assignment", () => {
  const tpl = envTemplate();
  for (const key of ["IKBI_OPERATOR_TOKEN", "IKBI_WORKER_TOKEN", "IKBI_TRUST_HMAC_KEY", "IKBI_IDENTITY_TOKEN_SALT"]) {
    assert.doesNotMatch(tpl, new RegExp(`^${key}=`, "m"));
  }
  assert.match(tpl, /^IKBI_WORKER_MODEL_ENABLED=true$/m);
});

test("`ikbi help` lists the doctor command, and doctor is a reserved builtin", async () => {
  // run()/printUsage self-invoke on import (they read process.argv), so assert the
  // wiring at the source level: doctor is in the help listing AND the builtin set.
  const src = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  assert.match(src, /"\s*doctor\s+Report bootstrap config/, "the help usage lists the doctor command");
  assert.match(src, /BUILTINS = new Set\(\[[^\]]*"doctor"/, "doctor is a reserved builtin (cannot be shadowed)");
});
