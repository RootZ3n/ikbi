/**
 * execution-policy/risk — command-effect policy, focused on the verifier-purpose gate.
 *
 * Two adversarial-review findings are pinned here:
 *   F1 — the "verifier-only" script gate must NOT be unlockable by putting "check" in the command text
 *        (the terminal tool embeds the model's command in the purpose).
 *   F2 — `dlx`/`create` (download + run a remote package) must be gated like `run`, not allowed freely.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { commandPolicyDenyReason } from "./risk.js";

// The terminal tool's real purpose format — the MODEL's command is embedded verbatim.
const terminalPurpose = (cmd: string): string => `builder terminal: ${cmd}`;

test("F1: a model command cannot forge verifier authority by containing the word 'check'", () => {
  // The exact attack: `pnpm run evil check` — "check" in the command must NOT unlock script execution.
  const deny = commandPolicyDenyReason("pnpm", ["run", "evil", "check"], terminalPurpose("pnpm run evil check"));
  assert.match(deny ?? "", /script execution is allowed only/, "pnpm run <script> from a terminal command is DENIED");
  // "verifier" anywhere in the command is likewise powerless.
  assert.ok(commandPolicyDenyReason("pnpm", ["run", "verifier"], terminalPurpose("pnpm run verifier")) !== undefined);
});

test("F1: the LEGITIMATE verifier/check runners (trusted prefixes) are still allowed", () => {
  assert.equal(commandPolicyDenyReason("pnpm", ["test"], "verifier check: test"), undefined);
  assert.equal(commandPolicyDenyReason("pnpm", ["run", "typecheck"], "builder check: typecheck"), undefined);
  assert.equal(commandPolicyDenyReason("pnpm", ["run", "lint"], "patchsmith check: lint"), undefined);
  assert.equal(commandPolicyDenyReason("pnpm", ["test"], "verifier[ladder:impact] test (root)"), undefined);
});

test("F2: pnpm/yarn dlx and create (run a fetched remote package) are gated like run", () => {
  assert.match(commandPolicyDenyReason("pnpm", ["dlx", "cowsay"], terminalPurpose("pnpm dlx cowsay")) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("pnpm", ["create", "vite"], terminalPurpose("pnpm create vite")) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("yarn", ["dlx", "x"], terminalPurpose("yarn dlx x")) ?? "", /script execution is allowed only/);
  // And they are NOT unlockable by the "check" trick either.
  assert.ok(commandPolicyDenyReason("pnpm", ["dlx", "check"], terminalPurpose("pnpm dlx check")) !== undefined);
});

test("non-script package commands (install) are not caught by the script gate", () => {
  assert.equal(commandPolicyDenyReason("pnpm", ["install"], terminalPurpose("pnpm install")), undefined);
});
