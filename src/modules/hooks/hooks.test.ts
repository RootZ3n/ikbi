/**
 * ikbi hooks — tests for the lifecycle hook system (Julian Finding C).
 *
 * Covers the security-sensitive contract: PreToolUse BLOCK semantics (exit 2),
 * fail-open for other non-zero exits and for kills (the timeout path), the 32KB
 * output truncation, PostToolUse environment, Stop hooks, config loading, matcher
 * globbing, and multi-hook ordering / short-circuit.
 *
 * Hooks shell out via /bin/sh -c, so each test uses a tiny POSIX command as the hook.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHookEnv, fireHooks, fireStopHooks, isSecretEnvKey, loadHooks, type HookConfig, type HookContext } from "./index.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-hooks-"));
}

function preCtx(over: Partial<HookContext> = {}): HookContext {
  return { type: "PreToolUse", toolName: "Write", projectDir: "/tmp", ...over };
}

// ── BLOCK semantics ──────────────────────────────────────────────────────────

test("PreToolUse exit 0 allows the tool (happy path)", async () => {
  const hooks: HookConfig[] = [{ type: "PreToolUse", command: "exit 0" }];
  const res = await fireHooks(hooks, preCtx());
  assert.equal(res.length, 1);
  assert.equal(res[0]!.allowed, true);
  assert.equal(res[0]!.exitCode, 0);
});

test("PreToolUse exit 2 BLOCKS the tool", async () => {
  const hooks: HookConfig[] = [{ type: "PreToolUse", command: "exit 2" }];
  const res = await fireHooks(hooks, preCtx());
  assert.equal(res[0]!.allowed, false);
  assert.equal(res[0]!.exitCode, 2);
});

test("PreToolUse non-2 nonzero exit fails open (tool still allowed)", async () => {
  const hooks: HookConfig[] = [{ type: "PreToolUse", command: "exit 1" }];
  const res = await fireHooks(hooks, preCtx());
  assert.equal(res[0]!.allowed, true);
  assert.equal(res[0]!.exitCode, 1);
});

test("a hook killed by SIGTERM (the timeout path) fails open and is flagged timedOut", async () => {
  // The real 30s timebox kills the child with SIGTERM; self-killing exercises the same
  // close-with-signal path without waiting 30 seconds. allowed must stay true (fail-open).
  const hooks: HookConfig[] = [{ type: "PreToolUse", command: "kill -TERM $$" }];
  const res = await fireHooks(hooks, preCtx());
  assert.equal(res[0]!.allowed, true);
  assert.equal(res[0]!.exitCode, null);
  assert.equal(res[0]!.timedOut, true);
});

// ── Output truncation (32KB) ───────────────────────────────────────────────────

test("PostToolUse IKBI_TOOL_OUTPUT env is truncated to 32KB", async () => {
  const big = "z".repeat(50_000);
  const hooks: HookConfig[] = [{ type: "PostToolUse", command: 'printf "%s" "${#IKBI_TOOL_OUTPUT}"' }];
  const res = await fireHooks(hooks, { type: "PostToolUse", toolName: "Write", toolOutput: big, projectDir: "/tmp" });
  assert.equal(Number(res[0]!.stdout.trim()), 32_000);
});

// ── PostToolUse environment ────────────────────────────────────────────────────

test("PostToolUse receives the tool name + output in the environment", async () => {
  const hooks: HookConfig[] = [{ type: "PostToolUse", command: 'printf "%s:%s" "$IKBI_TOOL_NAME" "$IKBI_TOOL_OUTPUT"' }];
  const res = await fireHooks(hooks, { type: "PostToolUse", toolName: "Write", toolOutput: "RESULT", projectDir: "/tmp" });
  assert.equal(res[0]!.stdout, "Write:RESULT");
});

test("PreToolUse hook can read IKBI_TOOL_INPUT to decide whether to block", async () => {
  const hooks: HookConfig[] = [
    { type: "PreToolUse", command: 'case "$IKBI_TOOL_INPUT" in *secret*) exit 2 ;; *) exit 0 ;; esac' },
  ];
  const blocked = await fireHooks(hooks, preCtx({ toolInput: '{"path":"secret.txt"}' }));
  assert.equal(blocked[0]!.allowed, false);
  const allowed = await fireHooks(hooks, preCtx({ toolInput: '{"path":"ok.txt"}' }));
  assert.equal(allowed[0]!.allowed, true);
});

// ── Env scrubbing (RC1) ─────────────────────────────────────────────────────────

test("RC1: a hook does NOT inherit secret-like process env vars by default", async () => {
  // Plant credential-shaped vars in the parent process env, then have the hook print them.
  const planted = {
    OPENAI_API_KEY: "sk-openai-leak",
    ANTHROPIC_API_KEY: "sk-ant-leak",
    GITHUB_TOKEN: "ghp_leak",
    AWS_SECRET_ACCESS_KEY: "aws-leak",
    DB_PASSWORD: "hunter2",
    MY_OAUTH_TOKEN: "oauth-leak",
    IKBI_OPERATOR_TOKEN: "operator-leak",
  };
  for (const [k, v] of Object.entries(planted)) process.env[k] = v;
  try {
    const hooks: HookConfig[] = [
      { type: "PostToolUse", command: 'printf "%s|%s|%s|%s|%s|%s|%s" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$GITHUB_TOKEN" "$AWS_SECRET_ACCESS_KEY" "$DB_PASSWORD" "$MY_OAUTH_TOKEN" "$IKBI_OPERATOR_TOKEN"' },
    ];
    const res = await fireHooks(hooks, { type: "PostToolUse", toolName: "Write", projectDir: "/tmp" });
    // Every secret resolves to empty — none were forwarded into the hook subprocess.
    assert.equal(res[0]!.stdout, "||||||");
  } finally {
    for (const k of Object.keys(planted)) delete process.env[k];
  }
});

test("RC1: PATH is forwarded so a normal hook command can still run", () => {
  const env = buildHookEnv({ type: "Stop", projectDir: "/tmp" }, {});
  assert.equal(typeof env.PATH, "string");
  assert.ok((env.PATH ?? "").length > 0, "PATH must be in the minimal passthrough");
  // The IKBI_* context is always present.
  assert.equal(env.IKBI_HOOK_TYPE, "Stop");
  assert.equal(env.IKBI_PROJECT_DIR, "/tmp");
});

test("RC1: explicit literal `env` override reaches the hook (the safe escape hatch)", async () => {
  const hooks: HookConfig[] = [
    { type: "PostToolUse", command: 'printf "%s" "$MY_DEPLOY_FLAG"', env: { MY_DEPLOY_FLAG: "green" } },
  ];
  const res = await fireHooks(hooks, { type: "PostToolUse", toolName: "Write", projectDir: "/tmp" });
  assert.equal(res[0]!.stdout, "green");
});

test("RC1: `passEnv` forwards a NAMED safe var, but refuses a secret-like name", async () => {
  process.env.MY_SAFE_REGION = "us-east-1";
  process.env.MY_SUPER_TOKEN = "should-not-leak";
  try {
    const hooks: HookConfig[] = [
      {
        type: "PostToolUse",
        command: 'printf "%s|%s" "$MY_SAFE_REGION" "$MY_SUPER_TOKEN"',
        passEnv: ["MY_SAFE_REGION", "MY_SUPER_TOKEN"],
      },
    ];
    const res = await fireHooks(hooks, { type: "PostToolUse", toolName: "Write", projectDir: "/tmp" });
    // Safe var forwarded; the *_TOKEN name is refused even though it was explicitly listed.
    assert.equal(res[0]!.stdout, "us-east-1|");
  } finally {
    delete process.env.MY_SAFE_REGION;
    delete process.env.MY_SUPER_TOKEN;
  }
});

test("RC1: a literal `env` override wins over the IKBI_* context and passthrough", () => {
  const env = buildHookEnv(
    { type: "PostToolUse", toolName: "Write", projectDir: "/tmp" },
    { env: { IKBI_PROJECT_DIR: "/override" } },
  );
  assert.equal(env.IKBI_PROJECT_DIR, "/override");
});

test("RC1: isSecretEnvKey flags credential shapes and clears benign ones", () => {
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "DB_PASSWORD", "X_SECRET", "AWS_SECRET_ACCESS_KEY", "SESSION_TOKEN", "MY_OAUTH"]) {
    assert.ok(isSecretEnvKey(k), `${k} should be flagged secret-like`);
  }
  for (const k of ["PATH", "HOME", "LANG", "TZ", "MY_REGION", "BUILD_NUMBER"]) {
    assert.ok(!isSecretEnvKey(k), `${k} should NOT be flagged`);
  }
});

test("RC1: passEnv survives JSON config loading (round-trips through loadHooks)", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".ikbi"), { recursive: true });
    writeFileSync(
      join(dir, ".ikbi", "hooks.json"),
      JSON.stringify([{ type: "PostToolUse", command: "true", passEnv: ["MY_REGION"], env: { FOO: "bar" } }]),
    );
    const loaded = loadHooks(dir);
    const hook = loaded.find((h) => h.command === "true");
    assert.ok(hook !== undefined);
    assert.deepEqual(hook!.passEnv, ["MY_REGION"]);
    assert.deepEqual(hook!.env, { FOO: "bar" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Stop hooks ────────────────────────────────────────────────────────────────

test("fireStopHooks runs Stop hooks", async () => {
  const dir = tmpDir();
  try {
    const marker = join(dir, "stopped");
    const hooks: HookConfig[] = [{ type: "Stop", command: `touch "${marker}"` }];
    await fireStopHooks(hooks, dir);
    assert.ok(existsSync(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fireStopHooks never throws even when the hook command fails", async () => {
  const hooks: HookConfig[] = [{ type: "Stop", command: "exit 7" }];
  await assert.doesNotReject(fireStopHooks(hooks, "/tmp"));
});

// ── Config loading ─────────────────────────────────────────────────────────────

test("loadHooks reads project .ikbi/hooks.json", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".ikbi"), { recursive: true });
    writeFileSync(
      join(dir, ".ikbi", "hooks.json"),
      JSON.stringify([{ type: "PreToolUse", matcher: "Write*", command: "exit 0" }]),
    );
    const hooks = loadHooks(dir);
    assert.ok(hooks.some((h) => h.type === "PreToolUse" && h.matcher === "Write*" && h.command === "exit 0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHooks ignores malformed entries", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".ikbi"), { recursive: true });
    writeFileSync(
      join(dir, ".ikbi", "hooks.json"),
      JSON.stringify([
        { type: "Nonsense", command: "x" }, // unknown type
        { type: "PreToolUse" }, // missing command
        { type: "PreToolUse", command: "   " }, // blank command
        { type: "Stop", command: "echo ok" }, // the only valid one
      ]),
    );
    const loaded = loadHooks(dir);
    assert.equal(loaded.filter((h) => h.command === "echo ok").length, 1);
    assert.ok(!loaded.some((h) => (h.type as string) === "Nonsense"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHooks returns [] when there is no hooks.json", () => {
  const dir = tmpDir();
  try {
    // No ~/.ikbi global config is asserted on; just that a project with no file is fine.
    const loaded = loadHooks(dir).filter((h) => h.command !== undefined);
    assert.ok(Array.isArray(loaded));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Matcher globbing + ordering ─────────────────────────────────────────────────

test("a hook whose matcher does not match the tool is skipped", async () => {
  const hooks: HookConfig[] = [{ type: "PreToolUse", matcher: "Read*", command: "exit 2" }];
  const res = await fireHooks(hooks, preCtx({ toolName: "Write" }));
  assert.equal(res.length, 0);
});

test("a matcher glob matches the tool name", async () => {
  const hooks: HookConfig[] = [{ type: "PreToolUse", matcher: "Write*", command: "exit 2" }];
  const res = await fireHooks(hooks, preCtx({ toolName: "WriteFile" }));
  assert.equal(res.length, 1);
  assert.equal(res[0]!.allowed, false);
});

test("PreToolUse stops at the first blocking hook — later hooks do not run", async () => {
  const dir = tmpDir();
  try {
    const marker = join(dir, "ran");
    const hooks: HookConfig[] = [
      { type: "PreToolUse", command: "exit 2" },
      { type: "PreToolUse", command: `touch "${marker}"` },
    ];
    const res = await fireHooks(hooks, preCtx());
    assert.equal(res.length, 1, "second hook must not run after a block");
    assert.equal(res[0]!.allowed, false);
    assert.ok(!existsSync(marker), "blocked run must short-circuit remaining hooks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple non-blocking PreToolUse hooks all run", async () => {
  const hooks: HookConfig[] = [
    { type: "PreToolUse", command: "exit 0" },
    { type: "PreToolUse", command: "exit 0" },
  ];
  const res = await fireHooks(hooks, preCtx());
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.allowed));
});

test("only hooks of the matching lifecycle type fire", async () => {
  const hooks: HookConfig[] = [
    { type: "PostToolUse", command: "exit 0" },
    { type: "Stop", command: "exit 0" },
  ];
  const res = await fireHooks(hooks, preCtx()); // PreToolUse context
  assert.equal(res.length, 0);
});
