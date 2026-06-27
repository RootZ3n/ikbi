/**
 * ikbi governed-exec — OS-LEVEL SANDBOX for risky subprocesses (F1 fix).
 *
 * THE FINDING (F1): governed-exec confines the BINARY (allowlist), the CWD, and the path-like
 * ARGV, but it cannot confine the FILESYSTEM SYSCALLS an allowlisted interpreter performs. The
 * builder writes a helper script into the worktree (correctly confined) and runs it via
 * `node <script.js>` / `python3 <script.py>` (allowlisted) — the script then writes ANYWHERE the
 * user can write, via `../../x` or an absolute path. Inline `-e`/`-c` eval is already blocked; the
 * SCRIPT-FILE vector bypassed that. Argv validation is structurally insufficient.
 *
 * THE FIX: run risky commands inside a Linux `bubblewrap` (bwrap) sandbox where ONLY the worktree
 * and an ephemeral tmpfs are writable; the entire host (home, ~/.ikbi, /pehverse, /etc, repo
 * parents, arbitrary absolute paths) is READ-ONLY; the network namespace is unshared (denied)
 * unless an explicit per-command policy allows it. A subprocess can no longer escape the worktree —
 * not via `..`, not via an absolute path, not via a helper script. If the sandbox is unavailable,
 * risky commands FAIL CLOSED (no unsafe default override).
 *
 * This module is PURE planning + arg construction (plus one cached availability probe). The actual
 * spawn stays in exec.ts's default primitives, which call `wrapWithSandbox` — so an INJECTED
 * execFile (tests) is never rewritten, and the security path is only the real, default one.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

/** existsSync that never throws (e.g. on EACCES of an intermediate dir). */
function existsSyncSafe(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

/** How the operator wants risky commands sandboxed. */
export type SandboxMode = "auto" | "off" | "required";
//  auto     — sandbox risky commands when bwrap works; FAIL CLOSED (deny) when it does not.
//  required — same as auto for denial, but also refuses to start if bwrap is missing (strictest).
//  off      — do NOT sandbox (NOT for production; for unit tests / non-Linux dev only).

export interface SandboxConfig {
  readonly mode: SandboxMode;
  /**
   * EXPLICIT, NOISY, DEFAULT-OFF override for a single trusted local operator: when the sandbox is
   * unavailable, run risky commands UNSANDBOXED instead of denying. Every such run is loudly
   * receipted as `sandbox.unavailable` + risk-classified. There is NO unsafe default — this must be
   * opted into via `IKBI_GOVERNED_EXEC_TRUSTED_LOCAL=true`.
   */
  readonly trustedLocalOverride: boolean;
}

export const DEFAULT_SANDBOX_MODE: SandboxMode = "auto";

/** What kind of risk a command carries, and whether it needs the network to do legitimate work. */
export interface CommandRisk {
  /** True ⇒ this command can execute code / write files and MUST be sandboxed. */
  readonly risky: boolean;
  readonly kind: "interpreter" | "package-install" | "package-script" | "toolchain" | "write-tool" | "safe";
  /** True ⇒ a legitimate run needs network (dependency install); the sandbox keeps the net namespace. */
  readonly needsNetwork: boolean;
  readonly reason: string;
}

// Interpreters: running ANY of these executes arbitrary code (a script file or stdin), so they are
// always risky regardless of args. Inline `-e`/`-c` is separately blocked upstream (kept).
const INTERPRETERS = new Set([
  "node", "nodejs", "python", "python2", "python3", "tsx", "ts-node", "deno", "bun",
  "ruby", "perl", "php", "lua", "Rscript", "bash", "sh", "zsh", "dash", "ksh", "fish",
]);
// Native build/test toolchains that compile & RUN project-owned code.
const TOOLCHAINS = new Set([
  "cargo", "go", "godot", "java", "javac", "dotnet", "mvn", "gradle", "make", "cmake", "ninja",
  "pytest", "vitest", "jest", "mocha", "ava", "tap", "nyc", "c8", "phpunit", "rspec",
]);
// Package managers — risky because their scripts run project code; install-class subcommands also
// fetch from the network (and run lifecycle scripts).
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "pipenv", "gem", "bundle"]);
const PM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "update", "up", "upgrade", "fetch", "dlx", "create", "exec", "x", "dedupe", "rebuild", "link", "sync", "download"]);
// Coreutils that WRITE files — they execute no project code, but their path args can write outside
// the worktree (argv confinement does not cover them), so they are confined by the sandbox too.
const WRITE_TOOLS = new Set(["cp", "mkdir", "dd", "tee", "touch", "mv", "rm", "ln", "chmod", "chown", "install", "rsync", "truncate", "mknod", "sed", "awk"]);

/** Classify a command's execution risk. The sandbox enforces confinement for every `risky` verdict. */
export function classifyCommandRisk(command: string, args: readonly string[]): CommandRisk {
  const cmd = basename(command);
  if (INTERPRETERS.has(cmd)) {
    return { risky: true, kind: "interpreter", needsNetwork: false, reason: `${cmd} executes arbitrary code (script/stdin)` };
  }
  if (PACKAGE_MANAGERS.has(cmd)) {
    const sub = firstSubcommand(args);
    if (sub !== undefined && PM_INSTALL_SUBCOMMANDS.has(sub)) {
      return { risky: true, kind: "package-install", needsNetwork: true, reason: `${cmd} ${sub} fetches + runs lifecycle scripts` };
    }
    // pip/poetry/etc. with no subcommand still typically install; bare pip = risky+net to be safe.
    if ((cmd === "pip" || cmd === "pip3" || cmd === "poetry" || cmd === "pipenv" || cmd === "gem" || cmd === "bundle") && sub === undefined) {
      return { risky: true, kind: "package-install", needsNetwork: true, reason: `${cmd} installs project dependencies` };
    }
    return { risky: true, kind: "package-script", needsNetwork: false, reason: `${cmd} runs project scripts` };
  }
  if (TOOLCHAINS.has(cmd)) {
    // cargo/go fetch crates/modules on first build; allow network for them, fs still confined.
    const needsNetwork = cmd === "cargo" || cmd === "go" || cmd === "mvn" || cmd === "gradle" || cmd === "dotnet";
    return { risky: true, kind: "toolchain", needsNetwork, reason: `${cmd} compiles & runs project code` };
  }
  if (WRITE_TOOLS.has(cmd)) {
    return { risky: true, kind: "write-tool", needsNetwork: false, reason: `${cmd} can write files (argv confinement is insufficient)` };
  }
  return { risky: false, kind: "safe", needsNetwork: false, reason: `${cmd} does not execute project code` };
}

/** The available sandbox backend (probed once, cached). */
export interface SandboxAvailability {
  readonly available: boolean;
  readonly tool?: "bwrap";
  readonly version?: string;
  readonly reason?: string;
}

let cachedAvailability: SandboxAvailability | undefined;

/** Probe whether a working bwrap sandbox exists on this host. Cached after the first call. */
export function detectSandbox(probe: () => SandboxAvailability = bwrapProbe): SandboxAvailability {
  if (cachedAvailability === undefined) cachedAvailability = probe();
  return cachedAvailability;
}

/** Reset the cached probe (tests). */
export function resetSandboxAvailabilityCache(): void {
  cachedAvailability = undefined;
}

function bwrapProbe(): SandboxAvailability {
  try {
    const ver = spawnSync("bwrap", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (ver.status !== 0 || ver.error) return { available: false, reason: "bwrap not found or not executable" };
    const version = (ver.stdout || "").trim();
    // A version string alone is not enough — user namespaces may be disabled. Actually RUN a no-op
    // under the exact policy shape we use, so "available" means "works on THIS host", fail-closed.
    const run = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--unshare-all", "--die-with-parent", "--", "true"], { encoding: "utf8", timeout: 8000 });
    if (run.status !== 0 || run.error) {
      return { available: false, reason: `bwrap present (${version}) but a sandbox probe failed (user namespaces disabled?): ${(run.stderr || run.error?.message || "").toString().slice(0, 120)}` };
    }
    return { available: true, tool: "bwrap", version };
  } catch (e) {
    return { available: false, reason: `sandbox probe error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A concrete sandbox plan attached to an exec, consumed by the default exec primitive. */
export interface SandboxPlan {
  readonly mode: "bwrap" | "none";
  /** The single writable host root (the worktree). Absent ⇒ only the ephemeral tmpfs is writable. */
  readonly writableRoot?: string;
  readonly cwd?: string;
  readonly networkAllowed: boolean;
  readonly risk: CommandRisk;
  /**
   * EXTRA writable host paths beyond the worktree — used ONLY by dependency-install for the package
   * manager's store/cache dirs (an isolated/cache area), so a frozen install can fetch+hardlink. The
   * rest of the host stays read-only, so a postinstall script still cannot write ~/.bashrc, /etc,
   * /pehverse, repo parents, or ../../X. Each existing dir is bound read-write; non-existent ones are
   * skipped (bwrap cannot bind a missing source).
   */
  readonly extraWritable?: readonly string[];
}

/**
 * The package-manager store/cache dirs that an install must be able to write (fetch + hardlink),
 * derived from the real $HOME. Binding ONLY these writable (everything else read-only) lets a frozen
 * install proceed while still containing any postinstall script to {worktree, store/cache, tmpfs}.
 * Honors the standard env overrides operators set. Returns absolute paths (existence is checked at
 * bind time).
 */
export function packageManagerStoreDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? "";
  const dirs = [
    env.PNPM_HOME,
    env.npm_config_store_dir,
    env.npm_config_cache,
    env.XDG_DATA_HOME ? `${env.XDG_DATA_HOME}/pnpm` : undefined,
    env.XDG_CACHE_HOME ? `${env.XDG_CACHE_HOME}` : undefined,
    home ? `${home}/.local/share/pnpm` : undefined,
    home ? `${home}/.cache/pnpm` : undefined,
    home ? `${home}/.cache/node` : undefined,
    home ? `${home}/.npm` : undefined,
    home ? `${home}/.local/state/pnpm` : undefined,
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  return [...new Set(dirs)];
}

/**
 * Construct the bwrap argv that wraps `command args` under the worktree-confinement policy:
 *   • the entire host is bound READ-ONLY (`--ro-bind / /`) — the real $HOME, ~/.ikbi, /pehverse,
 *     /etc, repo parents, and ANY absolute path are read-only, so a write to them fails hard
 *     (EROFS). A relative `../../x` from the worktree resolves into this read-only area ⇒ also EROFS;
 *   • the worktree (`writableRoot`) is bound READ-WRITE — legitimate build writes still work;
 *   • `/tmp` is a fresh tmpfs ⇒ writes there (incl. an absolute `/tmp/x` escape) are sandbox-private
 *     and vanish when the command exits — they never appear on the host;
 *   • $HOME is left as the REAL (now read-only) home, NOT isolated: toolchains discover their
 *     packages/stores there (pnpm's store + deps-status check, python's `~/.local` user site, cargo's
 *     registry) so `pnpm test` / `python3 -m pytest` / `cargo test` run unchanged — but every write
 *     to home still fails (read-only), so containment holds. (An isolated tmpfs $HOME was tried first;
 *     it broke pnpm's deps-status check — it tried to purge+reinstall node_modules — and hid python's
 *     user site-packages. Read-only real home is both more compatible AND a stricter escape barrier.)
 *   • all namespaces unshared, incl. NETWORK (denied) unless `networkAllowed`;
 *   • `--die-with-parent` + `--new-session` ⇒ no escape via the controlling tty, clean teardown.
 */
export function buildBwrapArgs(plan: SandboxPlan, command: string, args: readonly string[]): string[] {
  const writableRoot = plan.writableRoot !== undefined ? canonical(plan.writableRoot) : undefined;
  const chdir = plan.cwd !== undefined ? canonical(plan.cwd) : writableRoot;
  const a: string[] = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
  ];
  if (writableRoot !== undefined) {
    a.push("--bind", writableRoot, writableRoot);
  }
  // Extra writable mounts (dependency-install's store/cache only). Bind each that EXISTS read-write,
  // skipping the worktree (already bound) and any missing dir (bwrap fails on a missing bind source).
  for (const raw of plan.extraWritable ?? []) {
    const p = canonical(raw);
    if (p === writableRoot || (writableRoot !== undefined && p.startsWith(writableRoot + "/"))) continue;
    if (existsSyncSafe(p)) a.push("--bind", p, p);
  }
  if (chdir !== undefined) {
    a.push("--chdir", chdir);
  }
  a.push("--unshare-all");
  if (plan.networkAllowed) a.push("--share-net");
  a.push("--die-with-parent", "--new-session", "--", command, ...args);
  return a;
}

/**
 * Apply a sandbox plan to a `(binary, args)` pair. For a `bwrap` plan it returns the wrapped
 * `{ binary: "bwrap", args: [...policy, "--", binary, ...args] }`; for `none` it returns the pair
 * unchanged. Called by the DEFAULT exec primitives only (injected test execFiles bypass it).
 */
export function wrapWithSandbox(plan: SandboxPlan | undefined, binary: string, args: readonly string[]): { binary: string; args: readonly string[] } {
  if (plan === undefined || plan.mode !== "bwrap") return { binary, args };
  return { binary: "bwrap", args: buildBwrapArgs(plan, binary, args) };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** The first non-flag argument (a package-manager subcommand like `install` / `run` / `test`). */
function firstSubcommand(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/** realpath when possible (so a symlinked worktree binds its canonical target); best-effort. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
