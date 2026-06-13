/**
 * ikbi `cost` — per-task cost breakdowns and trends from the receipt log.
 *
 *   ikbi cost                 cost breakdown for the last 7 days
 *   ikbi cost --days N        cost breakdown for the last N days
 *   ikbi cost --task <id>     cost breakdown for one task (all-time)
 *
 * Reads cost from `metadata.costUsd` and the model label from `metadata.model`
 * (same defensive convention as `summary` / the timeline endpoint). Read-only:
 * it only queries the receipt store. Builds are distinct `requestId`s.
 */

import { registerCommand } from "./registry.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";

/** The read surface the command needs (the store's query). Injectable for tests. */
export interface ReceiptReader {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

export interface CostCliDeps {
  readonly receipts?: ReceiptReader;
  readonly now?: () => number;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

/** Parse `--days <n>`/`--days=<n>` (default 7) and `--task <id>`/`--task=<id>`. */
export function parseCostArgs(argv: readonly string[]): { days: number; task?: string } {
  let days = 7;
  let task: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--days") { days = Number(argv[i + 1]); i += 1; }
    else if (a.startsWith("--days=")) days = Number(a.slice("--days=".length));
    else if (a === "--task") { task = argv[i + 1]; i += 1; }
    else if (a.startsWith("--task=")) task = a.slice("--task=".length);
  }
  const cleanDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
  return { days: cleanDays, ...(task !== undefined && task.length > 0 ? { task } : {}) };
}

/** Cost charged for a receipt, from `metadata.costUsd` (0 when absent/non-numeric). */
function costOf(r: Receipt): number {
  const c = (r.metadata as Record<string, unknown> | undefined)?.costUsd;
  return typeof c === "number" && Number.isFinite(c) ? c : 0;
}

/** Model label for a receipt, from `metadata.model` (falls back to "unknown"). */
function modelOf(r: Receipt): string {
  const m = (r.metadata as Record<string, unknown> | undefined)?.model;
  return typeof m === "string" && m.length > 0 ? m : "unknown";
}

/** A receipt's taskId is its requestId, or metadata.taskId (role receipts carry both). */
function taskIdOf(r: Receipt): string | undefined {
  if (r.requestId !== undefined) return r.requestId;
  const t = (r.metadata as Record<string, unknown> | undefined)?.taskId;
  return typeof t === "string" ? t : undefined;
}

/** UTC calendar day (YYYY-MM-DD) for a timestamp — the per-day bucket key. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const usd = (n: number): string => `$${n.toFixed(4)}`;

/** Sum the values of a map and return its entries sorted by value descending. */
function topDescending(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Build the `cost` handler. Default reads the live receipt store. */
export function createCostCli(deps: CostCliDeps = {}) {
  const store = deps.receipts ?? coreReceipts;
  const nowMs = deps.now ?? (() => Date.now());
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  const rule = `${"─".repeat(40)}\n`;

  /** `--task <id>`: per-model breakdown + total for one task's full trail. */
  function printTaskCost(task: string, all: readonly Receipt[]): void {
    const trail = all.filter((r) => taskIdOf(r) === task);
    if (trail.length === 0) {
      err(`ikbi cost: no receipts found for task "${task}"\n`);
      setExit(1);
      return;
    }
    const perModel = new Map<string, number>();
    let total = 0;
    for (const r of trail) {
      const c = costOf(r);
      total += c;
      perModel.set(modelOf(r), (perModel.get(modelOf(r)) ?? 0) + c);
    }

    out(`ikbi cost for task ${task}\n`);
    out(rule);
    out(`Per-model:\n`);
    for (const [model, c] of topDescending(perModel)) {
      out(`  ${model.padEnd(24)}${usd(c)}\n`);
    }
    out(rule);
    out(`  Total cost:   ${usd(total)}\n`);
    out(`  Receipts:     ${trail.length}\n`);
  }

  /** Default / `--days N`: per-day + per-model breakdown, totals, and trends. */
  function printPeriodCost(days: number, all: readonly Receipt[]): void {
    const perDay = new Map<string, number>();
    const perModel = new Map<string, number>();
    const perTask = new Map<string, number>();
    let total = 0;

    for (const r of all) {
      const c = costOf(r);
      total += c;
      perDay.set(dayOf(r.timestamp), (perDay.get(dayOf(r.timestamp)) ?? 0) + c);
      perModel.set(modelOf(r), (perModel.get(modelOf(r)) ?? 0) + c);
      const task = taskIdOf(r);
      if (task !== undefined) perTask.set(task, (perTask.get(task) ?? 0) + c);
    }

    const builds = perTask.size;
    const avg = builds > 0 ? total / builds : 0;
    const topTask = topDescending(perTask)[0];

    out(`ikbi cost report (last ${days} day${days === 1 ? "" : "s"})\n`);
    out(rule);
    out(`Per-day:\n`);
    if (perDay.size === 0) {
      out(`  (no activity)\n`);
    } else {
      for (const [day, c] of [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        out(`  ${day}   ${usd(c)}\n`);
      }
    }
    out(`Per-model:\n`);
    if (perModel.size === 0) {
      out(`  (no activity)\n`);
    } else {
      for (const [model, c] of topDescending(perModel)) {
        out(`  ${model.padEnd(24)}${usd(c)}\n`);
      }
    }
    out(rule);
    out(`  Total cost:          ${usd(total)}\n`);
    out(`  Builds:              ${builds}\n`);
    out(`  Average cost/build:  ${usd(avg)}\n`);
    out(`  Most expensive task: ${topTask !== undefined ? `${topTask[0]} (${usd(topTask[1])})` : "none"}\n`);
  }

  async function cost(argv: readonly string[]): Promise<void> {
    const { days, task } = parseCostArgs(argv);
    try {
      if (task !== undefined) {
        // No requestId clause in ReceiptQuery — query then filter by task in-process.
        printTaskCost(task, await store.query());
      } else {
        const fromTime = nowMs() - days * 24 * 60 * 60 * 1000;
        printPeriodCost(days, await store.query({ fromTime }));
      }
    } catch (e) {
      err(`ikbi cost: could not read the receipt log: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
    }
  }

  return { cost };
}

registerCommand({
  name: "cost",
  summary: "Per-task cost breakdowns and trends (last 7 days, or --days N / --task <id>)",
  usage: "ikbi cost [--days <n>] [--task <id>]",
  run: (argv) => createCostCli().cost(argv),
});
