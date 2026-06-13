/**
 * ikbi `workspaces` — operator view + lifecycle management of builder workspaces.
 *
 *   ikbi workspaces list             — table of every workspace (id, state, target repo, created)
 *   ikbi workspaces inspect <id>     — one workspace in detail (path, branch, refs, diff stats)
 *   ikbi workspaces clean [--apply]  — remove stale/terminal workspaces; DRY-RUN by default
 *
 * This is the broad operator surface that complements the focused `ikbi workspace`
 * (ls/discard) and `ikbi clean` commands. `clean` here is DRY-RUN by default — it only
 * REPORTS the terminal (promoted/discarded/failed) workspaces it would sweep — so an
 * operator can preview before mutating; `--apply` performs the reclaim. RETAINED failed
 * work (the only copy of uncommitted changes) is preserved unless `--force` is also passed.
 *
 * Read-mostly and crash-tolerant: it drives the workspace manager (list/get/diff/cleanOrphans)
 * and turns every failure into a friendly one-line message + non-zero exit — it never throws a
 * raw stack at the operator, and a corrupt/unreadable record degrades gracefully.
 */

import { registerCommand } from "./registry.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import type { WorkspaceRecord, WorkspaceState } from "../core/workspace/contract.js";
import { writeStderr, writeStdout } from "./io.js";

/** Result shape of the manager's orphan sweep (subset the command consumes). */
export interface CleanResult {
  readonly removed: number;
  readonly checked: number;
  readonly skipped?: number;
  readonly reclaimed?: number;
  readonly skippedIds?: readonly string[];
}

/** The workspace surface the command drives (injectable for tests). */
export interface WorkspacesCliSurface {
  list(): Promise<WorkspaceRecord[]>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
  diff(handle: WorkspaceRecord): Promise<string>;
  cleanOrphans(opts?: { force?: boolean }): Promise<CleanResult>;
}

export interface WorkspacesCliDeps {
  readonly workspaces?: WorkspacesCliSurface;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

/** Terminal lifecycle states — candidates for `clean` (promote/discard already tear down the rest). */
const TERMINAL_STATES: ReadonlySet<WorkspaceState> = new Set<WorkspaceState>(["promoted", "discarded", "failed"]);

/** True iff a failed record was deliberately RETAINED (its note is stamped `retained: …`). */
function isRetained(rec: WorkspaceRecord): boolean {
  return rec.state === "failed" && (rec.note ?? "").startsWith("retained:");
}

/** ISO timestamp, or a placeholder if the millisecond value is missing/not finite. */
function iso(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "(unknown)";
}

/** Diff statistics parsed from a unified-diff string (no git invocation — works on the diff we already have). */
export interface DiffStats {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Parse `files / insertions / deletions` out of a unified diff. Counts `diff --git` headers for
 * files (falling back to unique `+++` targets) and content `+`/`-` lines (excluding the `+++`/`---`
 * file headers and any hunk `@@` markers). Pure + defensive: an empty/garbled diff yields all-zero.
 */
export function parseDiffStats(diff: string): DiffStats {
  if (typeof diff !== "string" || diff.length === 0) return { files: 0, insertions: 0, deletions: 0 };
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  const targets = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+++ ")) targets.add(line.slice(4));
    else if (line.startsWith("---")) continue; // file header — not a deletion
    else if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  // Fallback for working-tree diffs that lack `diff --git` headers: count distinct `+++` targets.
  if (files === 0) files = targets.size;
  return { files, insertions, deletions };
}

/** Build the `workspaces` handler. Default drives the live workspace manager. */
export function createWorkspacesCli(deps: WorkspacesCliDeps = {}) {
  const workspaces: WorkspacesCliSurface = deps.workspaces ?? coreWorkspaces;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  async function list(): Promise<void> {
    let records: WorkspaceRecord[];
    try {
      records = await workspaces.list();
    } catch (e) {
      err(`ikbi workspaces list: failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (records.length === 0) {
      out("(no workspaces)\n");
      return;
    }
    // Stable, oldest-first ordering so the output is deterministic.
    records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const rows = records.map((r) => ({
      id: r.id,
      state: r.state + (isRetained(r) ? " (retained)" : ""),
      repo: r.targetRepo,
      created: iso(r.createdAt),
    }));
    const idW = Math.max(2, ...rows.map((r) => r.id.length));
    const stW = Math.max(5, ...rows.map((r) => r.state.length));
    const repoW = Math.max(11, ...rows.map((r) => r.repo.length));
    out(`${"ID".padEnd(idW)}  ${"STATE".padEnd(stW)}  ${"TARGET REPO".padEnd(repoW)}  CREATED\n`);
    for (const r of rows) {
      out(`${r.id.padEnd(idW)}  ${r.state.padEnd(stW)}  ${r.repo.padEnd(repoW)}  ${r.created}\n`);
    }
    out(`\n${records.length} workspace(s).\n`);
  }

  async function inspect(id: string | undefined): Promise<void> {
    if (id === undefined || id.length === 0) {
      err("ikbi workspaces inspect: a workspace id is required — usage: ikbi workspaces inspect <id>\n");
      setExit(1);
      return;
    }
    let rec: WorkspaceRecord | undefined;
    try {
      rec = await workspaces.get(id);
    } catch (e) {
      err(`ikbi workspaces inspect: could not read workspace "${id}": ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (rec === undefined) {
      err(`ikbi workspaces inspect: no workspace "${id}" found\n`);
      setExit(1);
      return;
    }
    out(`workspace ${rec.id}\n`);
    out(`  state:       ${rec.state}${isRetained(rec) ? " (retained — holds uncommitted work)" : ""}\n`);
    out(`  target repo: ${rec.targetRepo}\n`);
    out(`  base branch: ${rec.baseBranch}\n`);
    out(`  base ref:    ${rec.baseRef}\n`);
    out(`  branch:      ${rec.scratchBranch}\n`);
    out(`  path:        ${rec.path}\n`);
    out(`  created:     ${iso(rec.createdAt)}\n`);
    out(`  updated:     ${iso(rec.updatedAt)}\n`);
    if (rec.promotedTo !== undefined) out(`  promoted to: ${rec.promotedTo}\n`);
    if (rec.note !== undefined && rec.note.length > 0) out(`  note:        ${rec.note}\n`);
    // Diff stats are best-effort: a teardown/cleaned workspace or a transient git error must not
    // turn `inspect` into a crash — report it and still show the metadata above.
    try {
      const stats = parseDiffStats(await workspaces.diff(rec));
      out(`  diff:        ${stats.files} file(s), +${stats.insertions} -${stats.deletions}\n`);
    } catch (e) {
      out(`  diff:        (unavailable: ${e instanceof Error ? e.message : String(e)})\n`);
    }
  }

  async function clean(argv: readonly string[]): Promise<void> {
    const apply = argv.includes("--apply") || argv.includes("--no-dry-run");
    const force = argv.includes("--force") || argv.includes("-f");

    if (!apply) {
      // DRY-RUN (default): report the terminal workspaces a sweep WOULD reclaim. Read-only.
      let records: WorkspaceRecord[];
      try {
        records = await workspaces.list();
      } catch (e) {
        err(`ikbi workspaces clean: failed: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
        return;
      }
      const terminal = records.filter((r) => TERMINAL_STATES.has(r.state));
      const retained = terminal.filter(isRetained);
      const sweepable = force ? terminal : terminal.filter((r) => !isRetained(r));
      if (sweepable.length === 0 && retained.length === 0) {
        out("clean (dry-run): no stale workspaces to remove.\n");
        out("Run `ikbi workspaces clean --apply` to reclaim orphaned worktrees once there are candidates.\n");
        return;
      }
      out(`clean (dry-run): ${sweepable.length} stale workspace(s) would be reclaimed:\n`);
      sweepable.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      for (const r of sweepable) out(`  ${r.id}  ${r.state}  ${r.path}\n`);
      if (!force && retained.length > 0) {
        out(`\n${retained.length} retained workspace(s) holding uncommitted work are PRESERVED (use --force to include them):\n`);
        for (const r of retained) out(`  ${r.id}  ${r.path}\n`);
      }
      out(`\nNothing was removed. Re-run with --apply${force ? " --force" : ""} to perform the cleanup.\n`);
      return;
    }

    // --apply: perform the reclaim via the manager's orphan sweep.
    try {
      const r = await workspaces.cleanOrphans({ force });
      out(`clean: reclaimed ${r.removed} orphaned worktree(s) (checked ${r.checked} terminal workspace${r.checked === 1 ? "" : "s"}).\n`);
      const skipped = r.skipped ?? 0;
      if (skipped > 0) {
        out(
          `clean: PRESERVED ${skipped} retained workspace(s) holding uncommitted work — inspect with \`ikbi workspaces inspect <id>\`; ` +
            `sweep them too with \`ikbi workspaces clean --apply --force\`.\n`,
        );
      }
    } catch (e) {
      err(`ikbi workspaces clean: failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  async function workspacesCmd(argv: readonly string[]): Promise<void> {
    const sub = argv[0];
    switch (sub) {
      case "list":
      case "ls":
        await list();
        return;
      case "inspect":
      case "show":
        await inspect(argv[1]);
        return;
      case "clean":
        await clean(argv.slice(1));
        return;
      default:
        err(`ikbi workspaces: unknown subcommand "${sub ?? ""}" — usage: ikbi workspaces <list | inspect <id> | clean [--apply] [--force]>\n`);
        setExit(1);
    }
  }

  return { workspaces: workspacesCmd, list, inspect, clean };
}

registerCommand({
  name: "workspaces",
  summary: "Inspect and manage builder workspaces (list, inspect <id>, clean — dry-run by default)",
  usage: "ikbi workspaces <list | inspect <id> | clean [--apply] [--force]>",
  run: (argv) => createWorkspacesCli().workspaces(argv),
});
