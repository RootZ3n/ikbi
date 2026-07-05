/**
 * execution-policy — COMMAND RISK POLICY.
 *
 * Pure functions that evaluate command-level risk for the gate-wall and
 * governed-exec. This is defense-in-depth over the binary allowlist: `git` is
 * useful for read-only inspection, and package managers are needed by verifier
 * checks, but both have subcommands/flags that can mutate refs, escape the
 * worktree, or run arbitrary scripts outside the verifier path.
 *
 * MOVED from governed-exec/policy.ts to break the circular dependency
 * (gate-wall → governed-exec for this function, governed-exec → gate-wall
 * for the GateWall type). Now both import from this neutral module.
 */

const PM_COMMANDS = new Set(["npm", "pnpm", "npx", "yarn"]);

/**
 * Package-manager subcommands that RUN a script or a FETCHED remote package (vs installing declared deps).
 * Any of these = model-authored or remote code execution — gated to trusted check-runners only.
 * SECURITY (F2): `dlx`/`create` DOWNLOAD AND RUN a remote package (sandbox runs that class WITH network).
 * `run-script` is npm's alias for `run`; `init` runs a `create-*` initializer (== `create`).
 */
const PM_RUN_SUBCOMMANDS = new Set(["run", "run-script", "test", "start", "exec", "x", "dlx", "create", "init"]);

/**
 * Non-script yarn subcommands. yarn runs an IMPLICIT script for `yarn <name>` when <name> is not a
 * builtin (`yarn build` ≡ `yarn run build`), so any yarn first-positional NOT in this set is gated —
 * unknown ⇒ gated (fail-closed). Over-gating a rare builtin only affects model TERMINAL commands, since
 * verifier/check runs set the structured `verifier` flag and bypass the gate entirely.
 */
const SAFE_YARN_SUBCOMMANDS = new Set([
  "install", "add", "remove", "up", "upgrade", "why", "list", "info", "config", "dedupe", "import",
  "link", "unlink", "pack", "audit", "bin", "cache", "outdated", "licenses", "policies", "plugin",
  "set", "workspace", "workspaces", "versions", "version", "node", "global", "help",
]);

/** PM flags that REDIRECT where/how the command runs — a worktree-escape AND they hide the subcommand
 *  from any positional parse. Denied outright; legitimate verifier checks never use them. */
function pmRedirectFlag(args: readonly string[]): boolean {
  return args.some((a) => /^(--dir|--cwd|--prefix|--global-dir|--workspace-root|--config|--configdir|-C)(=|$)/i.test(a));
}

/**
 * Does this run+execute a package script or a fetched remote package (vs installing deps)?
 * SECURITY (F1 v2): scans ALL pre-`--` tokens for a run-class subcommand rather than only the first
 * positional — an option VALUE can otherwise HIDE the subcommand (`pnpm --loglevel x run evil`,
 * `pnpm --dir . run evil`). Over-approximates (a benign token equal to a run-class word is gated), which
 * is fail-closed and only affects model terminal commands (a check-runner sets `verifier` and is allowed).
 */
function isPackageScriptRun(command: string, args: readonly string[]): boolean {
  if (!PM_COMMANDS.has(command)) return false;
  const stop = args.indexOf("--"); // tokens after `--` are the script's own args, not pm subcommands
  const scan = stop >= 0 ? args.slice(0, stop) : args;
  const positional = (a: string): boolean => !a.startsWith("-");
  if (command === "npx") return scan.some(positional); // npx <anything> downloads + runs a package
  if (scan.some((a) => positional(a) && PM_RUN_SUBCOMMANDS.has(a))) return true;
  if (command === "yarn") {
    const first = scan.find(positional);
    if (first !== undefined && !SAFE_YARN_SUBCOMMANDS.has(first)) return true; // yarn implicit script
  }
  return false;
}

function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "-C" || a === "-c") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

function gitBranchForceDelete(args: readonly string[]): boolean {
  const sub = gitSubcommand(args);
  if (sub !== "branch") return false;
  return args.some((a) => a === "-f" || a === "--force" || a === "-D" || a === "--delete" || a.includes("D") && /^-[A-Za-z]+$/.test(a));
}

/** Detect `find` flags that execute arbitrary commands or write files. */
function findHasExecOrWrite(args: readonly string[]): boolean {
  return args.some((a) =>
    a === "-exec" || a === "-execdir" || a === "-ok" ||
    a === "-fprintf" || a === "-fprint" || a === "-delete" ||
    a === "-fls" || a === "-printf" && args.includes("-fprint")
  );
}

/**
 * Evaluate a command + args against the command-effect policy.
 * Returns a human-readable deny reason when the command should be blocked,
 * or `undefined` when the command is allowed.
 *
 * The policy is STRICTER than the binary allowlist: even an allowlisted binary
 * (e.g. `git`) can be denied for dangerous subcommands/flags.
 *
 * AUTHORITY (structural fix): whether the caller may run a package SCRIPT is decided by the STRUCTURED
 * `opts.verifier` flag — a boolean the trusted check-runner code paths set on their ExecRequest/gated
 * action, and which a model-initiated `terminal` command CANNOT set (the model only supplies a command
 * string). This replaces the old, fragile approach of parsing a free-text `purpose` for a trusted prefix,
 * which (a) let a model forge authority by putting "check" in its command and (b) kept silently breaking
 * legitimate check paths whenever a new prefix wasn't allow-listed. A command's TEXT can no longer grant
 * itself script-execution authority.
 */
export function commandPolicyDenyReason(command: string, args: readonly string[], opts?: { verifier?: boolean }): string | undefined {
  if (command === "git") {
    // Deny ALL git flags that redirect the working directory, config, or exec path.
    // -c sets git config for one invocation (including alias.* which runs shell commands).
    // --exec-path redirects the git exec directory.
    if (args.some((a) => a === "-C" || a === "-c" || a === "--git-dir" || a.startsWith("--git-dir=") || a === "--work-tree" || a.startsWith("--work-tree=") || a === "--exec-path" || a.startsWith("--exec-path="))) {
      return "git worktree/root/config/exec override flags are not allowed";
    }
    const sub = gitSubcommand(args);
    if (sub === "push" || sub === "update-ref" || sub === "config") return `git ${sub} is not allowed`;
    if (gitBranchForceDelete(args)) return "git branch force/delete operations are not allowed";
  }
  // find -exec/-execdir/-ok/-fprintf/-fprint/-delete execute arbitrary binaries or write files.
  if (command === "find" && findHasExecOrWrite(args)) {
    return "find exec/write flags are not allowed";
  }
  // A package manager's directory/config redirect flags let it operate OUTSIDE the worktree and hide the
  // subcommand from the script-run parse — denied outright (legit verifier checks never use them).
  if (PM_COMMANDS.has(command) && pmRedirectFlag(args)) {
    return `${command} directory/config redirect flags are not allowed (worktree escape)`;
  }
  if (isPackageScriptRun(command, args) && opts?.verifier !== true) {
    return `${command} script execution is allowed only for verifier/check runs`;
  }
  return undefined;
}
