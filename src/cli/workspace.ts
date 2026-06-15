/**
 * ikbi `workspace` — inspect and manage build workspaces (BLOCKER 3, state lifecycle).
 *
 *   ikbi workspace ls            — list workspaces (id, state, path), flagging RETAINED work
 *   ikbi workspace discard <id>  — deliberately remove ONE workspace (worktree dir + scratch branch)
 *   ikbi workspace clean         — bulk-remove terminal workspaces (dry-run, --retained, --stale)
 *
 * `ls` makes retained failed-build work discoverable (it is the only copy of uncommitted work);
 * `discard` is the explicit, per-workspace removal the failure message points operators to;
 * `clean` is the bulk removal path with filtering — unlike `ikbi clean`, it operates on
 * individual workspace records (not just orphaned worktrees) and supports dry-run preview.
 */

import { registerCommand } from "./registry.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import type { DiscardResult, WorkspaceRecord } from "../core/workspace/contract.js";
import { writeStderr, writeStdout } from "./io.js";

/** The workspace surface the command drives (injectable for tests). */
export interface WorkspaceCliSurface {
  list(): Promise<WorkspaceRecord[]>;
  get(id: string): Promise<WorkspaceRecord | undefined>;
  discard(handle: WorkspaceRecord): Promise<DiscardResult>;
}

export interface WorkspaceCliDeps {
  readonly workspaces?: WorkspaceCliSurface;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

/** True iff a failed record was deliberately RETAINED (its note is stamped `retained: …`). */
function isRetained(rec: WorkspaceRecord): boolean {
  return rec.state === "failed" && (rec.note ?? "").startsWith("retained:");
}

/** Human-readable age string for display in workspace clean output. */
function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s old`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m old`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h old`;
  return `${Math.floor(h / 24)}d old`;
}

/** Build the `workspace` handler. Default drives the live workspace manager. */
export function createWorkspaceCli(deps: WorkspaceCliDeps = {}) {
  const workspaces: WorkspaceCliSurface = deps.workspaces ?? coreWorkspaces;
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  async function ls(): Promise<void> {
    let records: WorkspaceRecord[];
    try {
      records = await workspaces.list();
    } catch (e) {
      err(`ikbi workspace ls: failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (records.length === 0) {
      out("(no workspaces)\n");
      return;
    }
    // Stable, oldest-first ordering so the output is deterministic.
    records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const idW = Math.max(2, ...records.map((r) => r.id.length));
    const stW = Math.max(5, ...records.map((r) => r.state.length));
    for (const r of records) {
      const flag = isRetained(r) ? "  [RETAINED]" : "";
      out(`${r.id.padEnd(idW)}  ${r.state.padEnd(stW)}  ${r.path}${flag}\n`);
    }
  }

  async function discard(id: string | undefined): Promise<void> {
    if (id === undefined || id.length === 0) {
      err("ikbi workspace discard: a workspace id is required — usage: ikbi workspace discard <workspace-id>\n");
      setExit(1);
      return;
    }
    let rec: WorkspaceRecord | undefined;
    try {
      rec = await workspaces.get(id);
    } catch (e) {
      err(`ikbi workspace discard: could not read workspace "${id}": ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (rec === undefined) {
      err(`ikbi workspace discard: no workspace "${id}" found\n`);
      setExit(1);
      return;
    }
    try {
      const r = await workspaces.discard(rec);
      out(`workspace ${id}: discarded (worktree + scratch branch removed).${r.removed ? "" : " (already gone)"}\n`);
    } catch (e) {
      err(`ikbi workspace discard: failed to discard "${id}": ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  // Terminal workspace states eligible for bulk clean.
  const TERMINAL_STATES: ReadonlySet<string> = new Set(["promoted", "failed", "discarded"]);

  async function clean(argv: readonly string[]): Promise<void> {
    const dryRun = argv.includes("--dry-run") || argv.includes("-n");
    const retainedOnly = argv.includes("--retained");
    const force = argv.includes("--force") || argv.includes("-f");
    const staleArg = argv.find((a) => a.startsWith("--stale="));
    const staleDays = staleArg !== undefined ? Number(staleArg.slice("--stale=".length)) : undefined;

    let records: WorkspaceRecord[];
    try {
      records = await workspaces.list();
    } catch (e) {
      err(`ikbi workspace clean: failed to list workspaces: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }

    const now = Date.now();
    const staleCutoffMs =
      staleDays !== undefined && Number.isFinite(staleDays) && staleDays > 0
        ? now - staleDays * 24 * 60 * 60 * 1000
        : undefined;

    const candidates = records.filter((r) => {
      if (!TERMINAL_STATES.has(r.state)) return false; // never touch active workspaces
      if (retainedOnly && !isRetained(r)) return false; // --retained: only retained ones
      // Without --force or --retained, preserved retained work (user must opt in explicitly).
      if (!force && !retainedOnly && isRetained(r)) return false;
      if (staleCutoffMs !== undefined && r.createdAt > staleCutoffMs) return false; // --stale filter
      return true;
    });

    if (candidates.length === 0) {
      out(
        retainedOnly
          ? "workspace clean: no retained workspaces to remove.\n"
          : "workspace clean: nothing to clean (use --force to include retained workspaces).\n",
      );
      return;
    }

    candidates.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    out(`workspace clean: ${dryRun ? "(dry run) " : ""}${candidates.length} workspace(s) to remove:\n`);
    for (const r of candidates) {
      const flag = isRetained(r) ? "  [RETAINED]" : "";
      const age = formatAge(now - r.createdAt);
      out(`  ${r.id}  ${r.state.padEnd(10)}  ${r.path}  (${age})${flag}\n`);
    }

    if (dryRun) {
      out("(dry run — run without --dry-run to remove)\n");
      return;
    }

    let removed = 0;
    let failed = 0;
    for (const r of candidates) {
      try {
        await workspaces.discard(r);
        removed++;
      } catch (e) {
        err(`workspace clean: failed to discard ${r.id}: ${e instanceof Error ? e.message : String(e)}\n`);
        failed++;
      }
    }
    out(`workspace clean: removed ${removed} workspace(s)${failed > 0 ? `, ${failed} failed (see stderr)` : ""}.\n`);
    if (failed > 0) setExit(1);
  }

  async function workspace(argv: readonly string[]): Promise<void> {
    const sub = argv[0];
    switch (sub) {
      case "ls":
      case "list":
        await ls();
        return;
      case "discard":
      case "rm":
        await discard(argv[1]);
        return;
      case "clean":
        await clean(argv.slice(1));
        return;
      default:
        err(`ikbi workspace: unknown subcommand "${sub ?? ""}" — usage: ikbi workspace <ls|discard <id>|clean>\n`);
        setExit(1);
    }
  }

  return { workspace, ls, discard, clean };
}

registerCommand({
  name: "workspace",
  summary: "List, discard, or bulk-clean build workspaces",
  usage: "ikbi workspace <ls | discard <id> | clean [--dry-run] [--retained] [--stale=N] [--force]>",
  run: (argv) => createWorkspaceCli().workspace(argv),
});
