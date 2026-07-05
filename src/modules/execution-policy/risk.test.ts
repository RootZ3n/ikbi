/**
 * execution-policy/risk — command-effect policy.
 *
 * The authority to run a package SCRIPT is a STRUCTURED flag (`opts.verifier`) set only by trusted
 * check-runner code paths — NOT parsed from a free-text purpose. A model-initiated terminal command
 * cannot set it, so command TEXT can never grant itself script-execution authority. These tests pin:
 *   - a model command (verifier:false) is denied any package-script / remote-package run;
 *   - a trusted check-runner (verifier:true) is allowed;
 *   - the run-detection is robust (option values can't hide the subcommand; dlx/create/implicit-yarn gated);
 *   - dir/config redirect flags are denied outright (worktree escape).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { commandPolicyDenyReason } from "./risk.js";

const MODEL = { verifier: false } as const; // a model-initiated terminal command
const CHECK = { verifier: true } as const; // a trusted check-runner (verifier / run_checks / fix / patchsmith)

test("authority: a model command (verifier:false) may NOT run package scripts; a check-runner may", () => {
  assert.match(commandPolicyDenyReason("pnpm", ["run", "build"], MODEL) ?? "", /script execution is allowed only/);
  assert.equal(commandPolicyDenyReason("pnpm", ["run", "build"], CHECK), undefined, "a trusted check-runner is allowed");
  // The DEFAULT (no opts) is treated as non-verifier — fail-closed.
  assert.match(commandPolicyDenyReason("pnpm", ["test"]) ?? "", /script execution is allowed only/);
});

test("authority CANNOT be forged by command text (the old F1 bypass)", () => {
  // "check"/"verifier" anywhere in the command is now powerless — authority is the structured flag.
  assert.match(commandPolicyDenyReason("pnpm", ["run", "evil", "check"], MODEL) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("pnpm", ["run", "verifier"], MODEL) ?? "", /script execution is allowed only/);
});

test("F2/round-3: dlx/create/run-script/init and yarn-implicit are all gated for a model command", () => {
  for (const args of [["dlx", "cowsay"], ["create", "vite"], ["run-script", "evil"], ["init", "evil"]]) {
    assert.match(commandPolicyDenyReason("pnpm", args, MODEL) ?? "", /script execution is allowed only/, args.join(" "));
  }
  assert.match(commandPolicyDenyReason("yarn", ["dlx", "x"], MODEL) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("yarn", ["build"], MODEL) ?? "", /script execution is allowed only/, "yarn implicit script");
  assert.match(commandPolicyDenyReason("yarn", ["evil"], MODEL) ?? "", /script execution is allowed only/);
});

test("round-3 #1: an option VALUE cannot hide the run subcommand", () => {
  assert.match(commandPolicyDenyReason("pnpm", ["--dir", ".", "run", "evil"], MODEL) ?? "", /redirect flags|script execution/);
  assert.match(commandPolicyDenyReason("pnpm", ["--loglevel", "silent", "run", "evil"], MODEL) ?? "", /script execution is allowed only/);
  assert.match(commandPolicyDenyReason("npm", ["--prefix", ".", "run", "evil"], MODEL) ?? "", /redirect flags|script execution/);
});

test("round-3 #1: dir/config redirect flags are denied outright (worktree escape) — even for a check-runner", () => {
  assert.match(commandPolicyDenyReason("pnpm", ["--dir", "/etc", "install"], MODEL) ?? "", /redirect flags/);
  assert.match(commandPolicyDenyReason("yarn", ["--cwd", "/tmp", "install"], CHECK) ?? "", /redirect flags/, "checks never use these either");
});

test("non-script package commands (install/add) are not caught by the script gate", () => {
  assert.equal(commandPolicyDenyReason("pnpm", ["install"], MODEL), undefined);
  assert.equal(commandPolicyDenyReason("pnpm", ["add", "lodash"], MODEL), undefined);
  assert.equal(commandPolicyDenyReason("yarn", ["install"], MODEL), undefined);
});

test("git dangerous subcommands/flags are denied regardless of the verifier flag", () => {
  assert.match(commandPolicyDenyReason("git", ["push"], CHECK) ?? "", /git push is not allowed/);
  assert.match(commandPolicyDenyReason("git", ["-c", "alias.x=!sh", "status"], MODEL) ?? "", /override flags/);
});
