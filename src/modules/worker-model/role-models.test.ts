import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadConfig } from "../../core/config.js";
import { criticModel, driverModel } from "./role-models.js";

test("role models DEFAULT to the historical constants (regression — unchanged behavior)", () => {
  const cfg = loadConfig({}); // no model env set
  assert.equal(driverModel(cfg), "mimo-v2.5", "driver tier defaults to the old hardcode");
  assert.equal(criticModel(cfg), "mimo-v2.5-pro", "critic tier defaults to the old hardcode");
});

test("IKBI_MODEL_DRIVER repoints the DRIVER tier (scout + builder), leaving critic alone", () => {
  const cfg = loadConfig({ IKBI_MODEL_DRIVER: "qwen3:4b" });
  assert.equal(driverModel(cfg), "qwen3:4b", "scout+builder now request the operator's driver id");
  assert.equal(criticModel(cfg), "mimo-v2.5-pro", "critic is unaffected by the driver override");
});

test("IKBI_MODEL_CRITIC repoints the CRITIC tier, leaving the driver alone", () => {
  const cfg = loadConfig({ IKBI_MODEL_CRITIC: "qwen3:14b" });
  assert.equal(criticModel(cfg), "qwen3:14b");
  assert.equal(driverModel(cfg), "mimo-v2.5");
});

test("the DETERMINISTIC roles (verifier, integrator) make NO model request — untouched by this change", async () => {
  for (const role of ["verifier", "integrator"]) {
    const src = await readFile(fileURLToPath(new URL(`./${role}.ts`, import.meta.url)), "utf8");
    assert.equal(/\.invokeModel\s*\(/.test(src), false, `${role} is deterministic — it never invokes a model`);
    assert.equal(src.includes("role-models"), false, `${role} does not use a model id (no config-driven model)`);
  }
});
