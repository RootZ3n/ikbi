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

/** Format a byte count as a human-readable string (KB/MB/GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Build the `clean` handler. Default reclaims via the live workspace manager. */
export function createCleanCli(deps: CleanCliDeps = {}) {
  const workspaces: CleanWorkspaces = deps.workspaces ?? coreWorkspaces;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  async function clean(argv: readonly string[] = []): Promise<void> {
    const force = argv.includes("--force") || argv.includes("-f");
    const yes = argv.includes("--yes") || argv.includes("-y");
    try {
      // `--force` sweeps RETAINED worktrees — the only copy of a failed build's uncommitted work — and
      // is irreversible. Unlike orphan reclaim (safe, always immediate), it requires an explicit --yes.
      // Without it, do the SAFE orphan-only pass and PREVIEW what --force would destroy, then stop. This
      // brings `ikbi clean` in line with `workspaces clean` needing --apply for the destructive step.
      if (force && !yes) {
        const preview = await workspaces.cleanOrphans({ force: false });
        out(`clean: reclaimed ${preview.removed} orphaned worktree(s) (checked ${preview.checked} terminal workspace${preview.checked === 1 ? "" : "s"}).\n`);
        const wouldSweep = preview.skipped ?? 0;
        out(
          wouldSweep > 0
            ? `clean: --force WOULD ALSO DESTROY ${wouldSweep} retained workspace(s) holding uncommitted work — inspect with \`ikbi workspace ls\` / \`ikbi diff <id>\` first, then re-run \`ikbi clean --force --yes\` to sweep them.\n`
            : `clean: nothing retained to sweep — --force has no additional effect.\n`,
        );
        return;
      }
      const r = await workspaces.cleanOrphans({ force });
      const reclaimedStr = r.reclaimed !== undefined && r.reclaimed > 0 ? `, freed ~${formatBytes(r.reclaimed)}` : "";
      out(`clean: reclaimed ${r.removed} orphaned worktree(s) (checked ${r.checked} terminal workspace${r.checked === 1 ? "" : "s"})${reclaimedStr}.\n`);
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
  summary: "Reclaim orphaned worktrees from terminal workspaces (retained work is preserved; --force --yes sweeps it)",
  usage: "ikbi clean [--force [--yes]]",
  run: (argv) => createCleanCli().clean(argv),
});
