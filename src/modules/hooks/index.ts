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
 * ENV SCRUBBING (RC1 — fail-closed by default): a hook command does NOT inherit ikbi's full
 * process environment. If it did, every operator-configured hook would receive whatever API keys,
 * provider tokens, and OAuth secrets ikbi was started with. Instead a hook gets only:
 *   1. a MINIMAL safe passthrough of process env (PATH/HOME/locale — see SAFE_ENV_PASSTHROUGH),
 *   2. the IKBI_* context vars above,
 *   3. anything the operator EXPLICITLY opts into, two ways:
 *        • `passEnv: ["MY_SAFE_VAR"]` — forward named process-env vars (secret-like names are
 *           refused even here; see isSecretEnvKey),
 *        • `env: { "MY_VAR": "literal" }` — operator-authored literal key/values from their OWN
 *           hooks.json (the escape hatch for a value a hook genuinely needs — never sourced from
 *           ikbi's process env, so it cannot leak an inherited secret).
 * Secret-shaped names (*_KEY / *_TOKEN / *_SECRET / *_PASSWORD, provider/OAuth/GitHub tokens)
 * are never forwarded from the process environment by default.
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
  /**
   * Literal env vars set for THIS hook's command — operator-authored in their own hooks.json and
   * therefore intentional. Applied LAST, so they win over the passthrough/context. Use this (not
   * `passEnv`) when a hook needs a value that resembles a secret. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Names of PROCESS-env vars to forward to this hook (opt-in). A safe widening of the minimal
   * passthrough — but secret-like names (see isSecretEnvKey) are still REFUSED here, so `passEnv`
   * can never re-expose an inherited API key/token. For a genuinely-needed secret value, use the
   * literal `env` map instead. */
  readonly passEnv?: readonly string[];
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

/**
 * The MINIMAL set of process-env vars always forwarded to a hook command — just enough for a normal
 * tool to run (a working PATH, a HOME, locale + temp dir). Deliberately small: a hook inherits NONE
 * of ikbi's other environment, so API keys / provider tokens / OAuth secrets are never exposed.
 */
const SAFE_ENV_PASSTHROUGH: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE",
  "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "TEMP", "TMP", "PWD", "HOSTNAME",
];

/**
 * True when an env var NAME looks like a credential. Used to refuse forwarding secret-shaped vars
 * from the process environment even when a hook explicitly lists them in `passEnv`. Covers the
 * common shapes (*_KEY / *_TOKEN / *_SECRET / *_PASSWORD) plus provider, OAuth, GitHub, and
 * session/cookie credential names. The escape hatch for a value a hook truly needs is the hook's
 * literal `env` map (operator-authored, never sourced from ikbi's own environment).
 */
export function isSecretEnvKey(key: string): boolean {
  return /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?|API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|OAUTH|SESSION[_-]?TOKEN|COOKIE)/i.test(key);
}

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
      // RC1: the SCRUBBED env only — NOT `{ ...process.env, ...env }`. `env` is the fully-built
      // safe environment (minimal passthrough + IKBI_* context + explicit opt-ins). A hook never
      // inherits ikbi's API keys / provider tokens.
      env,
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

/**
 * Build the SCRUBBED environment a hook command runs with (RC1). Layered, last-wins:
 *   1. minimal safe passthrough from process.env (SAFE_ENV_PASSTHROUGH, never secret-like),
 *   2. operator opt-in `passEnv` forwards by name (secret-like names refused),
 *   3. the documented IKBI_* context vars,
 *   4. operator-authored literal `env` overrides (win over everything above).
 * The full process environment is NEVER spread in — an inherited secret cannot reach a hook.
 */
export function buildHookEnv(ctx: HookContext, hook: Pick<HookConfig, "env" | "passEnv">): Record<string, string> {
  const env: Record<string, string> = {};

  // 1) Minimal safe passthrough (PATH/HOME/locale). Belt-and-suspenders: still skip secret-like.
  for (const key of SAFE_ENV_PASSTHROUGH) {
    const val = process.env[key];
    if (val !== undefined && !isSecretEnvKey(key)) env[key] = val;
  }

  // 2) Operator opt-in forwards from the process env — by NAME, still refusing secret-like names.
  if (Array.isArray(hook.passEnv)) {
    for (const key of hook.passEnv) {
      if (typeof key !== "string" || key.length === 0 || isSecretEnvKey(key)) continue;
      const val = process.env[key];
      if (val !== undefined) env[key] = val;
    }
  }

  // 3) ikbi-provided context (the documented IKBI_* vars).
  env.IKBI_HOOK_TYPE = ctx.type;
  if (ctx.toolName !== undefined) env.IKBI_TOOL_NAME = ctx.toolName;
  if (ctx.toolInput !== undefined) env.IKBI_TOOL_INPUT = ctx.toolInput;
  env.IKBI_PROJECT_DIR = ctx.projectDir;
  if (ctx.toolOutput !== undefined) env.IKBI_TOOL_OUTPUT = ctx.toolOutput.slice(0, MAX_OUTPUT_LENGTH);

  // 4) Operator-authored literal overrides (their own hooks.json — intentional, never inherited).
  if (hook.env !== null && typeof hook.env === "object") {
    for (const [k, v] of Object.entries(hook.env)) {
      if (typeof k === "string" && k.length > 0 && typeof v === "string") env[k] = v;
    }
  }

  return env;
}

/** Run all matching hooks for a context. Returns results with allowed=false if any PreToolUse blocked. */
export async function fireHooks(
  hooks: readonly HookConfig[],
  ctx: HookContext,
): Promise<HookResult[]> {
  const matching = hooks.filter(
    (h) => h.type === ctx.type && (ctx.toolName === undefined || hookMatches(h, ctx.toolName ?? "*")),
  );

  const results: HookResult[] = [];

  for (const hook of matching) {
    // Env is built PER HOOK — each hook's own `env`/`passEnv` opt-ins apply only to it.
    const result = await runHookCommand(hook.command, buildHookEnv(ctx, hook));
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
