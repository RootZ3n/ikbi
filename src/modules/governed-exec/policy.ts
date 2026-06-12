/**
 * Command effect policy shared by terminal, governed-exec, and gate-wall.
 *
 * This is defense-in-depth over the binary allowlist: `git` is useful for read-only
 * inspection, and package managers are needed by verifier checks, but both have
 * subcommands/flags that can mutate refs, escape the worktree, or run arbitrary
 * scripts outside the verifier path.
 */

const PM_COMMANDS = new Set(["npm", "pnpm", "npx"]);

function isVerifierPurpose(purpose: string | undefined): boolean {
  if (purpose === undefined) return false;
  return /\b(check|verifier)\b/i.test(purpose);
}

function isPackageScriptRun(command: string, args: readonly string[]): boolean {
  if (!PM_COMMANDS.has(command)) return false;
  const first = args.find((a) => !a.startsWith("-"));
  if (command === "npx") return first !== undefined;
  return first === "run" || first === "test" || first === "start" || first === "exec" || first === "x";
}

function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "-C") {
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

export function commandPolicyDenyReason(command: string, args: readonly string[], purpose?: string): string | undefined {
  if (command === "git") {
    if (args.some((a) => a === "-C" || a === "--git-dir" || a.startsWith("--git-dir=") || a === "--work-tree" || a.startsWith("--work-tree="))) {
      return "git worktree/root override flags are not allowed";
    }
    const sub = gitSubcommand(args);
    if (sub === "push" || sub === "update-ref") return `git ${sub} is not allowed`;
    if (gitBranchForceDelete(args)) return "git branch force/delete operations are not allowed";
  }
  if (isPackageScriptRun(command, args) && !isVerifierPurpose(purpose)) {
    return `${command} script execution is allowed only for verifier/check runs`;
  }
  return undefined;
}
