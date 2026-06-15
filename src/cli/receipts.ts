/**
 * ikbi `receipts` — operator view of the durable operational log (SG-4).
 *
 *   ikbi receipts                 recent receipts (most-recent last)
 *   ikbi receipts --task <id>     the full trail of one run (roles, verification, promote)
 *   ikbi receipts [--limit <n>]   cap the recent list
 *
 * Read-only: it only `query()`s the receipt store (no writes, no identity, no network).
 */

import { registerCommand } from "./registry.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";

/** The read surface the command needs (the store's query). Injectable for tests. */
export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

export interface ReceiptsCliDeps {
  readonly receipts?: ReceiptReader;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

/** Parse `--task <id>`/`--task=<id>`, `--limit <n>`/`--limit=<n>`, `--latest`, `--failures`. */
export function parseReceiptsArgs(argv: readonly string[]): { task?: string; limit?: number; latest?: boolean; failures?: boolean } {
  let task: string | undefined;
  let limit: number | undefined;
  let latest = false;
  let failures = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--task") { task = argv[i + 1]; i += 1; }
    else if (a.startsWith("--task=")) task = a.slice("--task=".length);
    else if (a === "--limit") { limit = Number(argv[i + 1]); i += 1; }
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
    else if (a === "--latest") latest = true;
    else if (a === "--failures") failures = true;
  }
  return {
    ...(task !== undefined && task.length > 0 ? { task } : {}),
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    ...(latest ? { latest } : {}),
    ...(failures ? { failures } : {}),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
/** A receipt's taskId is its requestId, or metadata.taskId (role receipts carry both). */
function taskIdOf(r: Receipt): string | undefined {
  if (r.requestId !== undefined) return r.requestId;
  const t = (r.metadata as Record<string, unknown> | undefined)?.taskId;
  return typeof t === "string" ? t : undefined;
}

/** Build the `receipts` handler. Default reads the live receipt store. */
export function createReceiptsCli(deps: ReceiptsCliDeps = {}) {
  const store = deps.receipts ?? coreReceipts;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  function printTaskTrail(task: string, all: readonly Receipt[]): void {
    const trail = all.filter((r) => taskIdOf(r) === task);
    if (trail.length === 0) {
      err(`ikbi receipts: no receipts found for task "${task}"\n`);
      setExit(1);
      return;
    }
    const roleReceipts = trail.filter((r) => r.operation.startsWith("worker.role."));
    const roleOf = (r: Receipt): string => {
      const m = (r.metadata as Record<string, unknown> | undefined)?.role;
      return typeof m === "string" ? m : r.operation.replace(/^worker\.role\./, "");
    };
    const verifier = roleReceipts.find((r) => roleOf(r) === "verifier");
    const promote = trail.find((r) => r.operation === "workspace.promote");
    out(`Task ${task}\n`);
    if (roleReceipts.length > 0) out(`  roles: ${roleReceipts.map((r) => `${roleOf(r)}=${r.outcome.status}`).join(", ")}\n`);
    out(`  verification: ${verifier !== undefined ? verifier.outcome.status : "(not run)"}\n`);
    out(`  promote: ${promote !== undefined ? `${promote.outcome.status}${promote.outcome.detail !== undefined ? ` (${promote.outcome.detail})` : ""}` : "(none)"}\n`);
    out(`  receipts: ${trail.length}\n`);
    for (const r of trail) {
      out(`    [${iso(r.timestamp)}] ${r.operation} → ${r.outcome.status}${r.outcome.detail !== undefined ? ` (${r.outcome.detail})` : ""}\n`);
    }
  }

  function printRecent(list: readonly Receipt[]): void {
    if (list.length === 0) {
      out("no receipts yet\n");
      return;
    }
    out(`${list.length} receipt(s) (most recent last):\n`);
    for (const r of list) {
      out(`  #${r.seq} [${iso(r.timestamp)}] ${r.operation} → ${r.outcome.status}  by ${r.identity.agentId}${r.requestId !== undefined ? `  (task ${r.requestId})` : ""}\n`);
    }
  }

  async function receipts(argv: readonly string[]): Promise<void> {
    const { task, limit, latest, failures } = parseReceiptsArgs(argv);
    try {
      if (task !== undefined) {
        // No requestId clause in ReceiptQuery — query then filter by task in-process.
        printTaskTrail(task, await store.query());
      } else if (latest === true) {
        // --latest: show only the single most-recent receipt (last in most-recent-last order).
        const all = await store.query({});
        const last = all.length > 0 ? all[all.length - 1] : undefined;
        if (last === undefined) { out("no receipts yet\n"); return; }
        printRecent([last]);
      } else if (failures === true) {
        // --failures: show only non-success receipts (failure, rejected, partial).
        const all = await store.query(limit !== undefined ? { limit } : {});
        const failed = all.filter((r) => r.outcome.status !== "success");
        if (failed.length === 0) { out("no failed receipts\n"); return; }
        out(`${failed.length} failed receipt(s) (most recent last):\n`);
        for (const r of failed) {
          out(`  #${r.seq} [${iso(r.timestamp)}] ${r.operation} → ${r.outcome.status}  by ${r.identity.agentId}${r.requestId !== undefined ? `  (task ${r.requestId})` : ""}${r.outcome.detail !== undefined ? `  ${r.outcome.detail}` : ""}\n`);
        }
      } else {
        printRecent(await store.query(limit !== undefined ? { limit } : {}));
      }
    } catch (e) {
      err(`ikbi receipts: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  return { receipts };
}

registerCommand({
  name: "receipts",
  summary: "Show receipt history (--task, --latest, --failures, --limit)",
  usage: "ikbi receipts [--task <id>] [--latest] [--failures] [--limit <n>]",
  run: (argv) => createReceiptsCli().receipts(argv),
});
