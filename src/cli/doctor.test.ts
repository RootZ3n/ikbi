import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadConfig } from "../core/config.js";
import { runDoctor, type DoctorInputs } from "./doctor.js";

/** A config + module-config set with EVERYTHING required satisfied (the ready case). */
function readyInputs(over: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    config: loadConfig({
      IKBI_OPERATOR_TOKEN: "op-secret-strong-value",
      IKBI_WORKER_TOKEN: "worker-secret-strong-value",
      IKBI_TRUST_HMAC_KEY: "a-real-hmac-key",
      IKBI_IDENTITY_TOKEN_SALT: "a-real-salt",
      IKBI_MIMO_API_KEY: "k",
    }),
    workerModelEnabled: true,
    governedExecAllowlist: ["git", "pnpm"],
    egressAllowlist: ["api.mimo.example"],
    egressLocalEndpoints: [],
    ...over,
  };
}

test("doctor REPORTS MISSING required settings and ends NOT ready (cold start)", () => {
  const r = runDoctor({
    config: loadConfig({}), // nothing set
    workerModelEnabled: false,
    governedExecAllowlist: ["git", "ls"], // no pnpm
    egressAllowlist: [],
    egressLocalEndpoints: [],
  });
  assert.equal(r.ready, false);
  assert.equal(r.missingRequired, 5, "all five required-for-build settings are missing");
  const text = r.lines.join("\n");
  assert.match(text, /✗ IKBI_OPERATOR_TOKEN/);
  assert.match(text, /✗ IKBI_WORKER_TOKEN/);
  assert.match(text, /✗ IKBI_WORKER_MODEL_ENABLED/);
  assert.match(text, /✗ IKBI_GOVERNED_EXEC_ALLOWLIST/);
  assert.match(text, /✗ a model provider configured/);
  assert.match(text, /NOT ready — 5 required settings missing/);
});

test("doctor REPORTS READY when every required setting is satisfied", () => {
  const r = runDoctor(readyInputs());
  assert.equal(r.missingRequired, 0);
  assert.equal(r.ready, true);
  assert.match(r.lines.join("\n"), /ready to build/);
});

test("doctor counts a keyless LOCAL endpoint as a configured provider", () => {
  // No API key, but a local endpoint allowed (e.g. Ollama) → provider requirement satisfied.
  const r = runDoctor(
    readyInputs({
      config: loadConfig({ IKBI_OPERATOR_TOKEN: "o", IKBI_WORKER_TOKEN: "w" }),
      egressLocalEndpoints: ["127.0.0.1:11434"],
    }),
  );
  assert.match(r.lines.join("\n"), /✓ a model provider configured/);
  assert.equal(r.ready, true);
});

test("doctor FLAGS insecure security defaults (⚠), not as build-blockers", () => {
  const r = runDoctor({
    config: loadConfig({ IKBI_OPERATOR_TOKEN: "o", IKBI_WORKER_TOKEN: "w", IKBI_MIMO_API_KEY: "k" }),
    workerModelEnabled: true,
    governedExecAllowlist: ["pnpm"],
  });
  const text = r.lines.join("\n");
  assert.match(text, /⚠ IKBI_TRUST_HMAC_KEY/, "insecure trust key flagged");
  assert.match(text, /⚠ IKBI_IDENTITY_TOKEN_SALT/, "insecure token salt flagged");
  assert.equal(r.ready, true, "insecure defaults are warnings, not build-blockers");
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
  // It still reports the tokens as set.
  assert.match(text, /✓ IKBI_OPERATOR_TOKEN/);
  assert.match(text, /✓ IKBI_WORKER_TOKEN/);
});

test("doctor SHOWS the resolved role models (so the operator sees which models will be used)", () => {
  const r = runDoctor({ config: loadConfig({ IKBI_MODEL_DRIVER: "qwen3:4b", IKBI_MODEL_CRITIC: "qwen3:14b" }) });
  const text = r.lines.join("\n");
  assert.match(text, /IKBI_MODEL_DRIVER\s+= qwen3:4b/);
  assert.match(text, /IKBI_MODEL_CRITIC\s+= qwen3:14b/);
});

test("`ikbi help` lists the doctor command, and doctor is a reserved builtin", async () => {
  // run()/printUsage self-invoke on import (they read process.argv), so assert the
  // wiring at the source level: doctor is in the help listing AND the builtin set.
  const src = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  assert.match(src, /"\s*doctor\s+Report bootstrap config/, "the help usage lists the doctor command");
  assert.match(src, /BUILTINS = new Set\(\[[^\]]*"doctor"/, "doctor is a reserved builtin (cannot be shadowed)");
});
