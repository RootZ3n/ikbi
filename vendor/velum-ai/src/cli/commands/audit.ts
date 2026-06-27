/**
 * `velum audit tail <path>`    — show the most recent audit receipts.
 * `velum audit summary <path>` — redaction rates + top-firing patterns.
 *
 * Reads the JSONL audit log emitted when `auditLogPath` is configured.
 */

import { readFileSync, existsSync } from "node:fs";

import type { Receipt } from "../../core/receipts.js";

export interface AuditOptions {
  json?: boolean;
  /** Number of lines for `tail` (default 20). */
  limit?: number;
}

function readReceipts(path: string): Receipt[] {
  if (!existsSync(path)) {
    process.stderr.write(`velum audit: no audit log at ${path}\n`);
    return [];
  }
  const out: Receipt[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Receipt);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export async function runAudit(
  sub: string | undefined,
  path: string | undefined,
  options: AuditOptions = {},
): Promise<number> {
  if (!sub || (sub !== "tail" && sub !== "summary")) {
    process.stderr.write("velum audit: expected 'tail' or 'summary'\n  velum audit tail <path>\n  velum audit summary <path>\n");
    return 2;
  }
  const logPath = path ?? "./state/velum-audit.jsonl";
  const receipts = readReceipts(logPath);
  if (receipts.length === 0) return existsSync(logPath) ? 0 : 1;

  if (sub === "tail") return tail(receipts, options);
  return summary(receipts, options);
}

function tail(receipts: Receipt[], options: AuditOptions): number {
  const limit = options.limit ?? 20;
  const slice = receipts.slice(-limit);
  if (options.json) {
    process.stdout.write(JSON.stringify(slice, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`\nVelum audit — last ${slice.length} receipt(s)\n────────────────────────────\n`);
  for (const r of slice) {
    const pats = r.patterns?.length ? ` [${r.patterns.join(", ")}]` : "";
    const tool = r.toolName ? ` ${r.toolName}` : "";
    process.stdout.write(`${r.ts}  ${r.stage.padEnd(8)} ${r.decision.padEnd(10)}${tool}${pats}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

function summary(receipts: Receipt[], options: AuditOptions): number {
  const byStage: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  const byPattern: Record<string, number> = {};
  let redacted = 0;

  for (const r of receipts) {
    byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    for (const p of r.patterns ?? []) byPattern[p] = (byPattern[p] ?? 0) + 1;
    if (r.counts?.redacted) redacted += r.counts.redacted;
  }

  const total = receipts.length;
  const acted = (byDecision.block ?? 0) + (byDecision.review ?? 0) + (byDecision.warn ?? 0) +
    (byDecision.CREDENTIAL ?? 0) + (byDecision.PROMPT_INJECTION ?? 0);
  const rate = total > 0 ? ((acted / total) * 100).toFixed(1) : "0.0";

  const report = {
    total,
    actionRatePct: Number(rate),
    redactedValues: redacted,
    byStage,
    byDecision,
    topPatterns: Object.entries(byPattern).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`\nVelum audit summary (${total} receipts)\n────────────────────────────\n`);
  process.stdout.write(`Action rate    : ${rate}% (non-allow decisions)\n`);
  process.stdout.write(`Values redacted: ${redacted}\n`);
  process.stdout.write(`By stage       : ${fmt(byStage)}\n`);
  process.stdout.write(`By decision    : ${fmt(byDecision)}\n`);
  if (report.topPatterns.length) {
    process.stdout.write("Top patterns   :\n");
    for (const [name, count] of report.topPatterns) {
      process.stdout.write(`  ${String(count).padStart(5)}  ${name}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

function fmt(obj: Record<string, number>): string {
  return Object.entries(obj).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
}
