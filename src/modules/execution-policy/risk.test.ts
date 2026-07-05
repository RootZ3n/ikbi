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
  // A1 (regression): the CHAT REPL's run_checks uses "chat check:" — it MUST be allowed, else the
  // default `pnpm test` check is denied on every chat session (the F1 anchoring dropped this prefix).
  assert.equal(commandPolicyDenyReason("pnpm", ["test"], "chat check: test"), undefined, "chat run_checks is allowed");
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
  assert.equal(commandPolicyDenyReason("pnpm", ["add", "lodash"], terminalPurpose("pnpm add lodash")), undefined);
  assert.equal(commandPolicyDenyReason("yarn", ["install"], terminalPurpose("yarn install")), undefined);
});

test("round-3 #1: an option VALUE cannot hide the run subcommand from the gate", () => {
  // The bypass: `--dir .` / `--loglevel x` put a positional before `run`, so a first-positional check
  // saw the value, not `run`. Scanning all tokens closes it.
  assert.match(commandPolicyDenyReason("pnpm", ["--dir", ".", "run", "evil"], terminalPurpose("pnpm --dir . run evil")) ?? "", /redirect flags|script execution/);
  assert.match(commandPolicyDenyReason("pnpm", ["--loglevel", "silent", "run", "evil"], terminalPurpose("x")) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("npm", ["--prefix", ".", "run", "evil"], terminalPurpose("x")) ?? "", /redirect flags|script execution/);
});

test("round-3 #1: dir/config redirect flags are denied outright (worktree escape)", () => {
  assert.match(commandPolicyDenyReason("pnpm", ["--dir", "/etc", "install"], terminalPurpose("x")) ?? "", /redirect flags/);
  assert.match(commandPolicyDenyReason("yarn", ["--cwd", "/tmp", "install"], terminalPurpose("x")) ?? "", /redirect flags/);
});

test("round-3 #1: yarn IMPLICIT script + npm run-script/init are gated", () => {
  assert.match(commandPolicyDenyReason("yarn", ["build"], terminalPurpose("yarn build")) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("yarn", ["evil"], terminalPurpose("yarn evil")) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("npm", ["run-script", "evil"], terminalPurpose("x")) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("npm", ["init", "evil"], terminalPurpose("x")) ?? "", /script execution is allowed only/);
  // a verifier check via yarn still passes (trusted purpose bypasses the gate)
  assert.equal(commandPolicyDenyReason("yarn", ["test"], "verifier check: test"), undefined);
});

test("round-3 #2: `ikbi fix` / server-fix use `fix check:` — a legitimate trusted prefix", () => {
  assert.equal(commandPolicyDenyReason("pnpm", ["test"], "fix check: pnpm test"), undefined, "fix-mode checks are allowed");
});
