/**
 * `ikbi peh` model resolution: Pehlichi runs on his OWN model, separate from the build roster and
 * easy to change — a `--model` flag wins, else IKBI_PEH_MODEL, else the default pro model.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import "../egress/index.js";
import { resolvePehModel } from "./cli.js";

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.IKBI_PEH_MODEL;
  if (value === undefined) delete process.env.IKBI_PEH_MODEL;
  else process.env.IKBI_PEH_MODEL = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.IKBI_PEH_MODEL;
    else process.env.IKBI_PEH_MODEL = prev;
  }
}

test("default is a pro model when nothing is configured", () => {
  withEnv(undefined, () => assert.equal(resolvePehModel([]), "mimo-v2.5-pro"));
});

test("IKBI_PEH_MODEL overrides the default", () => {
  withEnv("mimo-v2.5-pro", () => assert.equal(resolvePehModel([]), "mimo-v2.5-pro"));
});

test("a --model flag wins over the env and the default", () => {
  withEnv("mimo-v2.5-pro", () => assert.equal(resolvePehModel(["--model", "deepseek-v4-pro"]), "deepseek-v4-pro"));
  withEnv(undefined, () => assert.equal(resolvePehModel(["--model", "glm-5.2"]), "glm-5.2"));
});

test("a dangling --model (no value) falls back to env/default, not a flag", () => {
  withEnv(undefined, () => assert.equal(resolvePehModel(["--model"]), "mimo-v2.5-pro"));
  withEnv(undefined, () => assert.equal(resolvePehModel(["--model", "--continue"]), "mimo-v2.5-pro"));
});
