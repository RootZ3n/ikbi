/**
 * ikbi `receipts` — operator view of the durable operational log (SG-4).
 *
 *   ikbi receipts                 recent receipts (most-recent last)
 *   ikbi receipts --task <id>     the full trail of one run (roles, verification, promote)
 *   ikbi receipts [--limit <n>]   cap the recent list
 *   ikbi receipts verify          check receipt integrity (seq numbers sequential, no gaps)
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
/**
 * Does this receipt belong to the trail the operator asked for?
 *
 * The old rule was "taskId = requestId, else metadata.taskId", and it made every v2 run
 * undiscoverable by its own task id: the canonical engine sets `requestId` to the RUN id, so
 * `--task <taskId>` matched nothing and reported "no receipts found" for a run sitting in the
 * log. v1 role receipts carry the task id in BOTH places, so preferring the explicit field costs
 * them nothing.
 *
 * It now matches any of the identities a receipt legitimately answers to — task, run, or build
 * session — because an operator holding one id from the output should not have to know which
 * field it came from to read the trail.
 */
function receiptIdentities(r: Receipt): readonly string[] {
  const meta = r.metadata as Record<string, unknown> | undefined;
  const pick = (key: string): string | undefined => (typeof meta?.[key] === "string" ? String(meta[key]) : undefined);
  return [pick("taskId"), pick("runId"), pick("buildSessionId"), r.requestId].filter((v): v is string => typeof v === "string" && v.length > 0);
}

function matchesTask(r: Receipt, query: string): boolean {
  return receiptIdentities(r).includes(query);
}

/** Result of a receipt integrity check. */
export interface VerifyResult {
  readonly total: number;
  readonly gaps: ReadonlyArray<{ afterSeq: number; beforeSeq: number }>;
  readonly ok: boolean;
}

/** Check receipt integrity: seq numbers must be sequential with no gaps. Pure, no I/O. */
export function verifyReceiptIntegrity(receipts: readonly Receipt[]): VerifyResult {
  if (receipts.length === 0) return { total: 0, gaps: [], ok: true };
  const sorted = [...receipts].sort((a, b) => a.seq - b.seq);
  const gaps: Array<{ afterSeq: number; beforeSeq: number }> = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.seq !== prev.seq + 1) {
      gaps.push({ afterSeq: prev.seq, beforeSeq: curr.seq });
    }
  }
  return { total: receipts.length, gaps, ok: gaps.length === 0 };
}

/** Build the `receipts` handler. Default reads the live receipt store. */
export function createReceiptsCli(deps: ReceiptsCliDeps = {}) {
  const store = deps.receipts ?? coreReceipts;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  function printTaskTrail(task: string, all: readonly Receipt[]): void {
    const trail = all.filter((r) => matchesTask(r, task));
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
    /*
      TWO ENGINES WRITE HERE, and this projection only knew one of them.

      v1 recorded a `worker.role.verifier` receipt per role and a `worker.run.summary`. The
      canonical v2 engine records neither: it writes ONE `run.summary` whose metadata carries the
      verification result directly. So every v2 build — every build, since the cutover — printed
      "verification: (not run)" while its checks had demonstrably run, and in the Apela case had
      run and FAILED. A projection that reports the absence of evidence that exists is worse than
      one that reports nothing, because it reads as a finding.
    */
    const summary = trail.find((r) => r.operation === "worker.run.summary" || r.operation === "run.summary");
    const meta = summary?.metadata as Record<string, unknown> | undefined;
    const str = (key: string): string | undefined => (typeof meta?.[key] === "string" ? String(meta[key]) : undefined);

    out(`Task ${task}\n`);
    if (str("runId") !== undefined) out(`  run: ${str("runId")}\n`);
    if (meta?.targetRepo !== undefined) out(`  repo: ${String(meta.targetRepo)}\n`);
    else if (str("repository") !== undefined) out(`  repo: ${str("repository")}\n`);
    if (meta?.targetBranch !== undefined) out(`  branch: ${String(meta.targetBranch)}\n`);
    if (meta?.model !== undefined) out(`  model: ${String(meta.model)}\n`);
    if (meta?.costUsd !== undefined) out(`  cost: $${Number(meta.costUsd).toFixed(6)}\n`);
    if (str("status") !== undefined) out(`  outcome: ${str("status")}${str("phase") !== undefined ? ` (${str("phase")})` : ""}\n`);
    if (typeof meta?.attempts === "number") out(`  attempts: ${meta.attempts}\n`);
    if (roleReceipts.length > 0) out(`  roles: ${roleReceipts.map((r) => `${roleOf(r)}=${r.outcome.status}`).join(", ")}\n`);

    // The v2 metadata is authoritative when present; the v1 role receipt is the fallback; only
    // when NEITHER exists is it honest to say the verification did not run.
    const v2Verification = str("verificationResult") ?? str("verification");
    const verificationLine =
      v2Verification !== undefined
        ? `${v2Verification}${str("verificationId") !== undefined ? ` (${str("verificationId")!.slice(0, 12)})` : ""}`
        : verifier !== undefined
          ? verifier.outcome.status
          : "(not run)";
    out(`  verification: ${verificationLine}\n`);
    out(`  promote: ${promote !== undefined ? `${promote.outcome.status}${promote.outcome.detail !== undefined ? ` (${promote.outcome.detail})` : ""}` : meta?.promoted === true ? "success (via run summary)" : str("promotion") !== undefined ? `${str("promotion")} (via run summary)` : "(none)"}\n`);
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

  async function verifyIntegrity(): Promise<void> {
    const all = await store.query({});
    const result = verifyReceiptIntegrity(all);
    out(`receipts: ${result.total} total\n`);
    if (result.ok) {
      out(`integrity: OK (seq 0..${result.total - 1} are sequential, no gaps)\n`);
      return;
    }
    out(`integrity: GAPS DETECTED (${result.gaps.length} gap(s))\n`);
    for (const g of result.gaps) {
      out(`  gap: seq ${g.afterSeq} → ${g.beforeSeq} (missing ${g.beforeSeq - g.afterSeq - 1} receipt(s))\n`);
    }
    setExit(1);
  }

  async function receipts(argv: readonly string[]): Promise<void> {
    // `receipts verify` is a positional subcommand, not a flag.
    if (argv[0] === "verify") {
      try { await verifyIntegrity(); } catch (e) {
        err(`ikbi receipts verify: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
      }
      return;
    }
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
        // --failures: filter FIRST, then apply limit — so --limit N means the N most-recent
        // failures, not "filter the most-recent N receipts for failures".
        const all = await store.query({});
        const allFailed = all.filter((r) => r.outcome.status !== "success");
        const failed = limit === 0 ? [] : (limit !== undefined ? allFailed.slice(-limit) : allFailed);
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
  summary: "Show receipt history (--task, --latest, --failures, --limit, verify)",
  usage: "ikbi receipts [verify] [--task <id>] [--latest] [--failures] [--limit <n>]",
  run: (argv) => createReceiptsCli().receipts(argv),
});
