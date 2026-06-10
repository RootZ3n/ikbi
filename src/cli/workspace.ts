/**
 * ikbi `workspace` — inspect and manage build workspaces (BLOCKER 3, state lifecycle).
 *
 *   ikbi workspace ls            — list workspaces (id, state, path), flagging RETAINED work
 *   ikbi workspace discard <id>  — deliberately remove ONE workspace (worktree dir + scratch branch)
 *
 * `ls` makes retained failed-build work discoverable (it is the only copy of uncommitted work);
 * `discard` is the explicit, per-workspace removal the failure message points operators to —
 * unlike `ikbi clean`, it never touches anything but the named workspace.
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
      default:
        err(`ikbi workspace: unknown subcommand "${sub ?? ""}" — usage: ikbi workspace <ls|discard <id>>\n`);
        setExit(1);
    }
  }

  return { workspace, ls, discard };
}

registerCommand({
  name: "workspace",
  summary: "List build workspaces (flagging retained work) or discard one by id",
  usage: "ikbi workspace <ls | discard <id>>",
  run: (argv) => createWorkspaceCli().workspace(argv),
});
