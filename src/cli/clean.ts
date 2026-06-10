/**
 * ikbi `clean` — reclaim orphaned worktrees (SG-7).
 *
 * Sweeps terminal workspaces (promoted / discarded / failed) whose worktree directory still
 * lingers under the workspace root and removes it (+ its scratch branch). Normal promote/
 * discard already clean up; this collects leftovers from crashes or interrupted runs.
 *
 * RETAINED-WORK SAFETY: a failed build's RETAINED worktree is the only copy of its uncommitted
 * work, so the default `ikbi clean` PRESERVES it (reporting the count) and never destroys it.
 * `ikbi clean --force` opts into sweeping retained work too.
 */

import { registerCommand } from "./registry.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import { writeStderr, writeStdout } from "./io.js";

/** The cleanup surface the command drives (injectable for tests). */
export interface CleanWorkspaces {
  cleanOrphans(opts?: { force?: boolean }): Promise<{ removed: number; checked: number; skipped?: number; reclaimed?: number; skippedIds?: readonly string[] }>;
}

export interface CleanCliDeps {
  readonly workspaces?: CleanWorkspaces;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

/** Build the `clean` handler. Default reclaims via the live workspace manager. */
export function createCleanCli(deps: CleanCliDeps = {}) {
  const workspaces: CleanWorkspaces = deps.workspaces ?? coreWorkspaces;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  async function clean(argv: readonly string[] = []): Promise<void> {
    const force = argv.includes("--force") || argv.includes("-f");
    try {
      const r = await workspaces.cleanOrphans({ force });
      out(`clean: reclaimed ${r.removed} orphaned worktree(s) (checked ${r.checked} terminal workspace${r.checked === 1 ? "" : "s"}).\n`);
      const skipped = r.skipped ?? 0;
      if (skipped > 0) {
        out(
          `clean: PRESERVED ${skipped} retained workspace(s) holding uncommitted work — inspect with \`ikbi workspace ls\` / \`ikbi diff <id>\`; ` +
            `remove with \`ikbi workspace discard <id>\` or sweep all with \`ikbi clean --force\`.\n`,
        );
      }
    } catch (e) {
      err(`ikbi clean: failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  return { clean };
}

registerCommand({
  name: "clean",
  summary: "Reclaim orphaned worktrees from terminal workspaces (retained work is preserved; --force sweeps it)",
  usage: "ikbi clean [--force]",
  run: (argv) => createCleanCli().clean(argv),
});
