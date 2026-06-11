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
import { runDoctor, type DoctorInputs, type DoctorRegistry } from "./doctor.js";

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

test("`ikbi help` lists the doctor command, and doctor is a reserved builtin", async () => {
  // run()/printUsage self-invoke on import (they read process.argv), so assert the
  // wiring at the source level: doctor is in the help listing AND the builtin set.
  const src = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  assert.match(src, /"\s*doctor\s+Report bootstrap config/, "the help usage lists the doctor command");
  assert.match(src, /BUILTINS = new Set\(\[[^\]]*"doctor"/, "doctor is a reserved builtin (cannot be shadowed)");
});
