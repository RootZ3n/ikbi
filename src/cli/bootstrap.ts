/**
 * ikbi CLI bootstrap — runs BEFORE any config-loading module is evaluated.
 *
 * Two startup conveniences, both at the CLI entrypoint (imported FIRST in cli/index.ts so
 * its side effects land before `core/config` is loaded transitively):
 *
 *  1. `.env` AUTOLOAD — load `<cwd>/.env` into `process.env` WITHOUT overriding anything the
 *     real environment already set. Dependency-free (no `dotenv` package — the offline
 *     environment has none, and this is a ~20-line parser), so `ikbi` picks up IKBI_* tokens
 *     from a project `.env` the way an operator expects.
 *
 *  2. READ-ONLY INFO COMMANDS load even on a fresh shell. `core/config` REFUSES to start on
 *     the built-in default trust keys (a production safety gate) — but that throws at IMPORT,
 *     before a command like `doctor`/`help` can run, surfacing a raw stack. These info commands
 *     perform NO trust operations, so for them (and only them) we enable the dev-keys opt-in if
 *     no real keys are set — config then LOADS and `doctor` can REPORT what's missing. A real
 *     build/batch still hits the production guard (it must set real keys).
 *
 * This module imports ONLY node builtins — it must not transitively load `core/config`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load a `.env` file into `env`, never overriding an already-set variable. Dependency-free.
 * Returns the names it set. Never throws — a missing/unreadable file is a no-op.
 */
export const CWD_DOTENV_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "IKBI_TRUST_HMAC_KEY",
  "IKBI_IDENTITY_TOKEN_SALT",
  "IKBI_OPERATOR_TOKEN",
  "IKBI_WORKER_TOKEN",
]);

export class CwdDotenvSecurityError extends Error {
  constructor(path: string, keys: readonly string[]) {
    super(`Refusing to load security key(s) from project .env (${path}): ${keys.join(", ")}. Move them to ~/.ikbi/env or the ikbi install-root .env.`);
    this.name = "CwdDotenvSecurityError";
  }
}

export function loadDotenv(path: string, env: NodeJS.ProcessEnv = process.env, opts: { readonly forbiddenKeys?: ReadonlySet<string> } = {}): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // no .env — nothing to load
  }
  const set: string[] = [];
  const forbiddenSeen: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (opts.forbiddenKeys?.has(key)) {
      forbiddenSeen.push(key);
      continue;
    }
    if (env[key] !== undefined) continue; // the real environment always wins
    let val = stripped.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
    set.push(key);
  }
  if (forbiddenSeen.length > 0) throw new CwdDotenvSecurityError(path, [...new Set(forbiddenSeen)].sort());
  return set;
}

export function installRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function loadBootstrapEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  opts: { readonly installRoot?: string; readonly homeDir?: string } = {},
): void {
  const root = opts.installRoot ?? installRoot();
  const home = opts.homeDir ?? homedir();
  loadDotenv(resolve(root, ".env"), env);
  loadDotenv(resolve(home, ".ikbi", "env"), env);
  const cwdEnv = resolve(cwd, ".env");
  if (cwdEnv !== resolve(root, ".env")) loadDotenv(cwdEnv, env, { forbiddenKeys: CWD_DOTENV_FORBIDDEN_KEYS });
}

/** Read-only info commands that perform NO trust operations (safe on the built-in dev keys). */
export const INFO_COMMANDS: ReadonlySet<string> = new Set([
  "doctor",
  "help",
  "--help",
  "-h",
  "version",
  "models",
  "providers",
  "capabilities",
  "diff", // read-only: prints a workspace's git diff; performs no trust operations
  "receipts", // read-only: prints the operational log; performs no trust operations
  "clean", // reclaims orphaned worktrees; performs no trust operations
]);

/**
 * For a read-only INFO command with no real trust keys set, enable the built-in dev-keys opt-in
 * so `core/config` LOADS (instead of the startup guard throwing a raw stack at import). Scoped
 * strictly to info commands — a real build/batch still gets the production guard. Returns true
 * iff it enabled the opt-in.
 */
export function enableDevKeysForInfoCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const cmd = argv[0];
  const isInfo = cmd === undefined || INFO_COMMANDS.has(cmd);
  if (!isInfo) return false;
  if (env.IKBI_ALLOW_INSECURE_DEV_KEYS !== undefined) return false; // operator already chose
  // Treat blank strings as missing too — config.ts:optStr() treats them as undefined,
  // so a blank key in .env would pass this check but still throw a raw stack from config.
  const keysMissing = !env.IKBI_TRUST_HMAC_KEY?.trim() || !env.IKBI_IDENTITY_TOKEN_SALT?.trim();
  if (!keysMissing) return false;
  env.IKBI_ALLOW_INSECURE_DEV_KEYS = "true";
  return true;
}

/**
 * Startup diagnostics (identity bootstrap, provider-roster load, etc.) are internal noise for
 * a user running `ikbi`, `ikbi help`, `ikbi models`, or the REPL — yet they leak to stderr the
 * moment stdout/stderr is a pipe (the TTY path is already `silent`; see core/log.ts). Default
 * the log level to `silent` for user-facing CLI invocations so those commands are clean, and
 * only surface logs when the operator opts in with `--verbose`/`--debug` (or pins
 * `IKBI_LOG_LEVEL` themselves). The long-running `serve` service keeps its operational logs.
 *
 * Runs at the CLI entrypoint BEFORE `core/config`/`core/log` are imported, so the root logger
 * is constructed at the resolved level and the import-time startup logs are suppressed too.
 * Returns the level it set (or undefined when it deferred to the operator / serve).
 */
export function suppressCliLogsByDefault(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.IKBI_LOG_LEVEL?.trim()) return undefined; // operator already chose — never override
  if (argv.includes("--debug")) { env.IKBI_LOG_LEVEL = "debug"; return "debug"; }
  if (argv.includes("--verbose")) { env.IKBI_LOG_LEVEL = "info"; return "info"; }
  if (argv[0] === "serve") return undefined; // a service — leave its operational logs at config level
  env.IKBI_LOG_LEVEL = "silent";
  return "silent";
}

/**
 * Short-lived CLI commands often exit immediately after printing. In some Node/pino
 * combinations, ordinary `process.stdout.write` output can be lost when stdout is a pipe
 * even though logger output has already flushed. Put stdio in blocking mode at the CLI
 * entrypoint so clean-env smoke tests and shell pipelines see the command body reliably.
 */
export function forceBlockingStdIoForCli(): void {
  type BlockingStream = NodeJS.WriteStream & { _handle?: { setBlocking?: (blocking: boolean) => void } };
  for (const stream of [process.stdout, process.stderr] as BlockingStream[]) {
    stream._handle?.setBlocking?.(true);
  }
}

// ── side effects (run at import, BEFORE core/config is evaluated) ────────────
forceBlockingStdIoForCli();
try {
  loadBootstrapEnv();
} catch (err) {
  process.stderr.write(`ikbi: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
enableDevKeysForInfoCommand(process.argv.slice(2));
suppressCliLogsByDefault(process.argv.slice(2));
