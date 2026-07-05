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
 * Is this purpose from a TRUSTED verifier/check code path (which is permitted to run package scripts),
 * as opposed to a model-initiated `terminal` command?
 *
 * SECURITY (F1): this MUST anchor on a fixed prefix the model cannot produce — it used to be a substring
 * test `/\b(check|verifier)\b/`, but the `terminal` tool builds its purpose as `builder terminal: <the
 * model's own command>`, so the model unlocked arbitrary `pnpm run <script>` execution merely by putting
 * the word "check" in its command line. The legitimate runners use a hardcoded `<role> check:` prefix
 * (builder `run_checks`, verifier, patchsmith) or `verifier[ladder:...]`; the model's `builder terminal:`
 * prefix matches NEITHER, so a command's text can no longer forge verifier authority.
 */
function isVerifierPurpose(purpose: string | undefined): boolean {
  if (purpose === undefined) return false;
  // The COMPLETE set of trusted check-runner prefixes (builder run_checks, verifier, patchsmith, and the
  // CHAT REPL's run_checks — session.ts `chat check:`) plus the ladder executor. `chat` MUST be here: the
  // chat REPL's default `test` check is `pnpm test`, which the package-script gate would otherwise DENY on
  // every session (regression from the F1 anchoring). None of these are forgeable — the model's terminal
  // purpose is `builder terminal: <cmd>`, which matches no trusted prefix.
  return /^(patchsmith|builder|verifier|chat) check:/i.test(purpose) || /^verifier\[ladder:/i.test(purpose);
}

/**
 * Does this run+execute a package script or a fetched remote package (as opposed to installing deps)?
 * SECURITY (F2): `dlx`/`create` (pnpm/yarn) — like `npx` — DOWNLOAD AND RUN an arbitrary remote package
 * (and the sandbox runs that class WITH network), so they are strictly more dangerous than `run` yet were
 * unlisted here and thus allowed unconditionally. They are now gated exactly like `run`/`exec`.
 */
function isPackageScriptRun(command: string, args: readonly string[]): boolean {
  if (!PM_COMMANDS.has(command)) return false;
  const first = args.find((a) => !a.startsWith("-"));
  if (command === "npx") return first !== undefined;
  return first === "run" || first === "test" || first === "start" || first === "exec" || first === "x" || first === "dlx" || first === "create";
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
 */
export function commandPolicyDenyReason(command: string, args: readonly string[], purpose?: string): string | undefined {
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
  if (isPackageScriptRun(command, args) && !isVerifierPurpose(purpose)) {
    return `${command} script execution is allowed only for verifier/check runs`;
  }
  return undefined;
}
