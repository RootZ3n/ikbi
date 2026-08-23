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
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { labTempDir, resolveTempRoot } from "../../core/temp-root.js";

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
  /**
   * THE GOVERNED TEMPORARY CHILD for this run — a host path under ikbi's validated temp root.
   *
   * Bound WRITABLE and exported as TMPDIR/TMP/TEMP inside the sandbox, so a subprocess writes its
   * scratch to the SAME governed place its parent does, and one wrapper cleans up after all of
   * them. Absent ⇒ the sandbox falls back to the private tmpfs at /tmp, which is a containment
   * barrier rather than a location anything of ours targets (see `buildBwrapArgs`).
   */
  readonly tempRoot?: string;
  /**
   * SANDBOX VIEW (V2-016A/B2). `worktree` (default) is the F1 policy: the WHOLE host is bound
   * READ-ONLY, worktree writable. `narrow` is the BUILDER READ-ONLY TERMINAL view: the host is NOT
   * mounted at all — only essential system dirs (for the binary to run), the explicit
   * `readonlyRoots` (the candidate + its git object store), and a private tmpfs are visible; the
   * `writableRoot` is the only writable host path; network is denied. Read-only host access still
   * discloses, so a read-only terminal must NOT see the whole host — hence the narrow view.
   */
  readonly view?: "worktree" | "narrow";
  /** narrow view only: the host paths bound READ-ONLY (candidate workspace + git common dir). */
  readonly readonlyRoots?: readonly string[];
}

/**
 * The minimal system directories a bound binary needs to run (dynamic linker, libraries, the
 * binary itself, ld cache / nsswitch in /etc). Bound READ-ONLY in the narrow view IF they exist —
 * everything NOT listed here (host home, /pehverse, /tmp/outside, arbitrary absolute paths) is
 * simply absent from the mount namespace, so it cannot be read at all.
 */
export const NARROW_SYSTEM_DIRS: readonly string[] = Object.freeze([
  "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc",
  "/nix", "/opt", "/run/current-system", "/run/opengl-driver",
]);

/**
 * Build the NARROW bwrap argv (V2-016A/B2): the host is NOT bound; only essential system dirs, the
 * explicit read-only roots (candidate + git store), and a writable temp + private /tmp are visible;
 * all namespaces (incl. NETWORK) are unshared. A read-only terminal thus cannot read a synthetic
 * file outside its candidate view, because that file is not in the namespace at all.
 */
export function buildNarrowBwrapArgs(plan: SandboxPlan, command: string, args: readonly string[]): string[] {
  // `/tmp` is masked, never used — see `buildBwrapArgs`. TMPDIR is the governed child when the
  // caller supplied one; otherwise the writable throwaway this view already hands the command.
  const a: string[] = ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const dir of NARROW_SYSTEM_DIRS) {
    if (existsSyncSafe(dir)) a.push("--ro-bind", dir, dir);
  }
  // The candidate (and its git object store) — READ-ONLY. A command may inspect, never write.
  for (const raw of plan.readonlyRoots ?? []) {
    const p = canonical(raw);
    if (existsSyncSafe(p)) a.push("--ro-bind", p, p);
  }
  // The ONE writable host path — a throwaway temp, never the candidate.
  if (plan.writableRoot !== undefined) {
    const w = canonical(plan.writableRoot);
    if (existsSyncSafe(w)) a.push("--bind", w, w);
  }
  a.push(...tempRootBwrapArgs(plan, plan.writableRoot !== undefined ? canonical(plan.writableRoot) : undefined));
  const chdir = plan.cwd !== undefined ? canonical(plan.cwd) : plan.readonlyRoots?.[0];
  if (chdir !== undefined) a.push("--chdir", chdir);
  // NEVER share the network from the read-only terminal.
  a.push("--unshare-all", "--die-with-parent", "--new-session", "--", command, ...args);
  return a;
}

/**
 * Bind the run's governed temporary child and point the standard temp variables at it.
 *
 * THE RULE THIS SERVES: no ikbi code uses /tmp, inside the sandbox or out. A subprocess that
 * called `os.tmpdir()` used to land on the sandbox's private tmpfs — contained, but still /tmp,
 * and invisible to the wrapper that accounts for scratch. Now it lands in the same governed child
 * the parent is using, which is bound at its REAL path so a path handed across the boundary means
 * the same thing on both sides.
 *
 * ONLY the run's own child is bound — never the shared root — so a subprocess cannot walk up into
 * a concurrent run's scratch. When the child is already inside the writable root there is nothing
 * to bind: it is writable already, and binding it twice makes bwrap fail.
 */
function tempRootBwrapArgs(plan: SandboxPlan, writableRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (plan.tempRoot === undefined) return ["--setenv", "TMPDIR", "/tmp"];
  const temp = canonical(plan.tempRoot);
  const out: string[] = [];
  const alreadyWritable = (p: string): boolean => writableRoot !== undefined && (p === writableRoot || p.startsWith(writableRoot + "/"));
  if (!alreadyWritable(temp) && existsSyncSafe(temp)) out.push("--bind", temp, temp);

  /*
    A HOME THAT IS ITSELF SCRATCH IS WRITABLE. Everything else about HOME is unchanged.

    The real home stays read-only — that is the F1 barrier and it is not touched. But a caller
    that points HOME at a directory inside the governed temporary root has said, structurally,
    "this home IS scratch": hermetic children and the verifier do exactly that. Before the lab
    rule those homes lived under /tmp, which the sandbox replaced with a writable tmpfs, so a
    toolchain could write its caches; moving them to the governed root silently made them
    read-only, and `pnpm test` then failed for want of a cache — a verifier result that said
    "fail" about the harness rather than about the candidate.

    Only a home UNDER the governed root qualifies, so nothing about the operator's real home, or
    any path outside that root, becomes writable.
  */
  const home = env.HOME;
  if (home !== undefined && home.length > 0) {
    const realHome = canonical(home);
    const governed = realHome === temp || realHome.startsWith(temp + "/") || isUnderGovernedRoot(realHome);
    if (governed && !alreadyWritable(realHome) && realHome !== temp && existsSyncSafe(realHome)) {
      out.push("--bind", realHome, realHome);
    }
  }

  out.push("--setenv", "TMPDIR", temp, "--setenv", "TMP", temp, "--setenv", "TEMP", temp);
  return out;
}

/**
 * Is `candidate` inside the GOVERNED TEMPORARY ROOT?
 *
 * Compared against the ROOT rather than against this process's own child, deliberately. A spawned
 * CLI resolves its own child under the same root, so a HOME the parent created is a cousin of the
 * subprocess's scratch, not a descendant of it — deriving the boundary from `exec-scratch` said
 * "not scratch" about a directory that plainly was one, and a sandboxed `pnpm` then failed for
 * want of a writable cache.
 *
 * The root is still a tight boundary: it is ikbi's own validated scratch area and nothing else.
 * A HOME anywhere outside it — the operator's real home above all — is unaffected and stays
 * read-only.
 */
function isUnderGovernedRoot(candidate: string): boolean {
  const resolution = resolveTempRoot();
  if (!resolution.ok) return false;
  const root = canonical(resolution.root);
  return candidate === root || candidate.startsWith(root + "/");
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
 * The PERSISTENT, ikbi-OWNED toolchain cache root. A sandboxed build's caches (Go's GOCACHE, .NET's
 * NuGet packages, Maven's local repo, Gradle's home) all live in the read-only real $HOME, so they
 * must be redirected somewhere writable. The first cut sent them to the ephemeral `/tmp` tmpfs —
 * correct but SLOW: every sandboxed call re-compiled std / re-downloaded every dependency. This dir is
 * bound writable AND persists across builds, so a toolchain fetches + compiles ONCE and reuses it.
 *
 * It is deliberately ikbi-namespaced (`<cache>/ikbi/toolchains`), NOT the operator's real ~/.m2 /
 * ~/.nuget / ~/.gradle — those stay untouched, so an adversarial build running under the sandbox can
 * poison only ikbi's own build cache, never the operator's. Honors XDG_CACHE_HOME.
 */
export function toolchainCacheBase(env: NodeJS.ProcessEnv = process.env): string {
  // NO /tmp FALLBACK. This used to read `env.HOME ?? "/tmp"`, so a process started without HOME
  // silently put ikbi's toolchain caches in the system temp directory — which the lab rule
  // forbids outright, and which would also have meant re-downloading every dependency each run.
  // Without HOME the governed temporary root is the correct home for a cache: lab-owned, on real
  // storage, and validated.
  const cacheHome =
    env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
      ? env.XDG_CACHE_HOME
      : env.HOME && env.HOME.length > 0
        ? join(env.HOME, ".cache")
        : join(labTempDir(env), "cache");
  return join(cacheHome, "ikbi", "toolchains");
}

/** Per-toolchain env redirects pointing each cache at a subdir of the persistent base (above). Empty
 *  for toolchains that cache in-worktree (Rust's target/) or need nothing. */
export function toolchainSandboxEnv(command: string, env: NodeJS.ProcessEnv = process.env): ReadonlyArray<readonly [string, string]> {
  const b = toolchainCacheBase(env);
  switch (basename(command)) {
    // Go: GOCACHE (build cache) + GOPATH (module cache lives at $GOPATH/pkg/mod). Without these a
    // sandboxed `go test` fails "package testing is not in std" (a cache-write EROFS on read-only HOME).
    case "go": return [["GOCACHE", join(b, "go", "build")], ["GOPATH", join(b, "go", "path")]];
    // .NET: NuGet package cache + CLI home (first-run sentinels — else DotnetFirstTimeUseConfigurer
    // throws writing to a read-only HOME); telemetry/logo off to avoid extra writes/noise.
    case "dotnet": return [["NUGET_PACKAGES", join(b, "nuget")], ["DOTNET_CLI_HOME", join(b, "dotnet")], ["DOTNET_CLI_TELEMETRY_OPTOUT", "1"], ["DOTNET_NOLOGO", "1"]];
    // Rust: cargo registry lives at $CARGO_HOME/registry — on a read-only HOME cargo cannot
    // update/fetch the index or download crates and silently falls back to a stale local cache
    // ("note: offline mode" / "no matching package named X found"). Redirect CARGO_HOME to the
    // persistent writable base; target/ stays in-worktree by default. The registry cache is
    // namespaced under <cache>/ikbi/toolchains, never the operator's real ~/.cargo.
    case "cargo": return [["CARGO_HOME", join(b, "cargo")]];
    // Maven local repo, carried as a JVM system property via MAVEN_OPTS.
    case "mvn": return [["MAVEN_OPTS", `-Dmaven.repo.local=${join(b, "m2")}`]];
    // Gradle home (caches, wrapper, downloaded deps).
    case "gradle": return [["GRADLE_USER_HOME", join(b, "gradle")]];
    default: return [];
  }
}

/**
 * The writable host paths a toolchain command needs bound into the sandbox: the persistent cache base
 * (created on demand so bwrap can bind it). Returns `[base]` for cache toolchains, `[]` otherwise.
 * Best-effort mkdir — if it fails the build still runs, just without a warm cache.
 */
export function toolchainCacheWritable(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (toolchainSandboxEnv(command, env).length === 0) return [];
  const base = toolchainCacheBase(env);
  try { mkdirSync(base, { recursive: true }); } catch { /* best-effort; buildBwrapArgs skips a missing bind source */ }
  return [base];
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
    // `/tmp` is masked with a fresh, empty tmpfs. This is a CONTAINMENT BARRIER, not a location
    // anything of ours uses: a third-party tool that hard-codes an absolute `/tmp/x` writes into a
    // private, ephemeral filesystem that vanishes with the process and never reaches the host.
    // TMPDIR points somewhere else entirely (below), so no ikbi code targets it.
    "--tmpfs", "/tmp",
  ];
  if (writableRoot !== undefined) {
    a.push("--bind", writableRoot, writableRoot);
  }
  // THE GOVERNED TEMPORARY CHILD. Bound writable at its real host path and named as TMPDIR/TMP/
  // TEMP, so `os.tmpdir()` inside the sandbox resolves to the same governed directory the parent
  // is using — the run's own child, not the shared root, so a subprocess cannot reach a sibling's
  // scratch by walking up.
  a.push(...tempRootBwrapArgs(plan, writableRoot));
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
  // Redirect toolchain caches (e.g. Go's GOCACHE/GOPATH) to the writable tmpfs — else a read-only
  // HOME makes `go test` fail to write its build cache. No-op for toolchains that cache in-worktree.
  for (const [k, v] of toolchainSandboxEnv(command)) a.push("--setenv", k, v);
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
  const bwrapArgs = plan.view === "narrow" ? buildNarrowBwrapArgs(plan, binary, args) : buildBwrapArgs(plan, binary, args);
  return { binary: "bwrap", args: bwrapArgs };
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
