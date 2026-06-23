/**
 * ikbi hooks — lifecycle event hook system (CC parity).
 *
 * Hooks fire on tool-use and build-completion events, running operator-configured
 * shell commands. Configured in `.ikbi/hooks.json` (project) and `~/.ikbi/hooks.json`
 * (global). Both files merged, project overrides global for same matcher+type.
 *
 * THREE HOOK TYPES (subset of CC's 8):
 *   PreToolUse  — before a tool executes (can BLOCK by exiting 2)
 *   PostToolUse — after a tool completes (read-only, output available)
 *   Stop        — when a build finishes
 *
 * ENVIRONMENT provided to hook commands:
 *   IKBI_HOOK_TYPE       — "PreToolUse" | "PostToolUse" | "Stop"
 *   IKBI_TOOL_NAME       — tool name (PreToolUse/PostToolUse only)
 *   IKBI_TOOL_INPUT      — JSON-serialized tool arguments (PreToolUse/PostToolUse)
 *   IKBI_PROJECT_DIR     — target repo path
 *   IKBI_TOOL_OUTPUT     — tool result string (PostToolUse only, truncated to 32KB)
 *
 * PreToolUse SAFETY: a hook exiting 2 BLOCKS the tool. Exit 0 = allow. Other exits
 * logged but allowed (fail-open for misconfigured hooks).
 *
 * TIMEBOX: each hook command gets 30 seconds. Timeout = logged + allowed (fail-open).
 * A hook that hangs must never block the build indefinitely.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type HookType = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookConfig {
  /** Which lifecycle event fires this hook. */
  readonly type: HookType;
  /** Glob pattern matching tool names (e.g. "Write*", "Bash", "*"). Default: "*". */
  readonly matcher?: string;
  /** Shell command to execute. */
  readonly command: string;
}

export interface HookContext {
  readonly type: HookType;
  readonly toolName?: string;
  readonly toolInput?: string;
  readonly toolOutput?: string;
  readonly projectDir: string;
}

export interface HookResult {
  readonly hook: HookConfig;
  readonly allowed: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

// ── Config loading ─────────────────────────────────────────────────────────

const HOOK_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 32_000;

function loadHookFile(path: string): HookConfig[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h: unknown): h is HookConfig =>
        typeof h === "object" && h !== null &&
        typeof (h as HookConfig).type === "string" &&
        ["PreToolUse", "PostToolUse", "Stop"].includes((h as HookConfig).type) &&
        typeof (h as HookConfig).command === "string" &&
        (h as HookConfig).command.trim().length > 0,
    );
  } catch {
    return [];
  }
}

/** Load hooks from both global (~/.ikbi/hooks.json) and project (.ikbi/hooks.json).
 *  Project hooks with the same type+matcher override global ones. */
export function loadHooks(projectDir: string): HookConfig[] {
  const globalPath = join(homedir(), ".ikbi", "hooks.json");
  const projectPath = join(projectDir, ".ikbi", "hooks.json");

  const global = loadHookFile(globalPath);
  const project = loadHookFile(projectPath);

  // Merge: project overrides global for same type+matcher
  const key = (h: HookConfig) => `${h.type}::${h.matcher ?? "*"}`;
  const merged = new Map<string, HookConfig>();
  for (const h of global) merged.set(key(h), h);
  for (const h of project) merged.set(key(h), h);

  return [...merged.values()];
}

// ── Glob matching ──────────────────────────────────────────────────────────

/** Simple glob match: * matches any sequence, ? matches one char. */
function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(value);
}

function hookMatches(hook: HookConfig, toolName: string): boolean {
  const pattern = hook.matcher ?? "*";
  return globMatch(pattern, toolName);
}

// ── Hook execution ─────────────────────────────────────────────────────────

function runHookCommand(command: string, env: Record<string, string>): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = execFile("/bin/sh", ["-c", command], {
      env: { ...process.env, ...env },
      timeout: HOOK_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_LENGTH,
      encoding: "utf8",
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT_LENGTH) stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT_LENGTH) stderr += d;
    });

    child.on("close", (code, signal) => {
      resolve({
        hook: { type: "Stop", command },
        allowed: code !== 2,
        exitCode: code,
        stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
        stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
        timedOut: signal === "SIGTERM" || false,
      });
    });

    child.on("error", (err) => {
      resolve({
        hook: { type: "Stop", command },
        allowed: true,
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        error: err.message,
      });
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

function buildEnv(ctx: HookContext): Record<string, string> {
  return {
    IKBI_HOOK_TYPE: ctx.type,
    ...(ctx.toolName !== undefined ? { IKBI_TOOL_NAME: ctx.toolName } : {}),
    ...(ctx.toolInput !== undefined ? { IKBI_TOOL_INPUT: ctx.toolInput } : {}),
    IKBI_PROJECT_DIR: ctx.projectDir,
    ...(ctx.toolOutput !== undefined ? { IKBI_TOOL_OUTPUT: ctx.toolOutput.slice(0, MAX_OUTPUT_LENGTH) } : {}),
  };
}

/** Run all matching hooks for a context. Returns results with allowed=false if any PreToolUse blocked. */
export async function fireHooks(
  hooks: readonly HookConfig[],
  ctx: HookContext,
): Promise<HookResult[]> {
  const matching = hooks.filter(
    (h) => h.type === ctx.type && (ctx.toolName === undefined || hookMatches(h, ctx.toolName ?? "*")),
  );

  const env = buildEnv(ctx);
  const results: HookResult[] = [];

  for (const hook of matching) {
    const result = await runHookCommand(hook.command, env);
    results.push({ ...result, hook });
    // For PreToolUse, a blocked hook stops further hooks
    if (ctx.type === "PreToolUse" && !result.allowed) break;
  }

  return results;
}

/** Fire Stop hooks after a build completes. Best-effort — never throws. */
export async function fireStopHooks(
  hooks: readonly HookConfig[],
  projectDir: string,
): Promise<void> {
  try {
    await fireHooks(hooks, { type: "Stop", projectDir });
  } catch {
    // Best-effort — hooks must never crash the build
  }
}
