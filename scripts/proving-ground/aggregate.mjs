// @ts-nocheck
/**
 * Aggregate multiple proving-ground run-sets (e.g. parallel shards of a burn-in) into one combined
 * evidence bundle: merged results.jsonl + a single summary.md with the hard-gate dashboard.
 *
 * Usage:
 *   node scripts/proving-ground/aggregate.mjs <out-dir> <shard-dir-1> <shard-dir-2> ...
 * Each shard-dir must contain a results.jsonl. The combined bundle is written to <out-dir>.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SUITES } from "./scenarios.mjs";

const [, , outArg, ...shardArgs] = process.argv;
if (!outArg || shardArgs.length === 0) {
  console.error("usage: node scripts/proving-ground/aggregate.mjs <out-dir> <shard-dir...>");
  process.exit(2);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

const rows = [];
for (const sd of shardArgs) {
  const f = join(resolve(sd), "results.jsonl");
  if (!existsSync(f)) { console.error(`WARN: no results.jsonl in ${sd}`); continue; }
  for (const ln of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    try { rows.push(JSON.parse(ln)); } catch {}
  }
}
if (rows.length === 0) { console.error("no rows aggregated"); process.exit(1); }

writeFileSync(join(outDir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const tally = { PASS: 0, PARTIAL: 0, SAFE_FAIL: 0, FAIL: 0, INCOMPLETE: 0, UNSAFE_FAIL: 0 };
let cost = 0;
for (const r of rows) { tally[r.result] = (tally[r.result] || 0) + 1; cost += r.cost_usd || 0; }
const total = rows.length;
const promoted = rows.filter((r) => r.promoted);
const promotedWithReceipt = promoted.filter((r) => (r.receipt_ids || []).length > 0);
const promotedUncleaned = promoted.filter((r) => !r.workspace_cleaned);
const timeouts = rows.filter((r) => r.timedOut);
const proRuns = rows.filter((r) => (r.model_path || []).some((m) => /pro|frontier|opus|sonnet|gpt-4|o1|o3/i.test(m)));
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

const lines = [
  `# ikbi Proving Ground — AGGREGATE (${shardArgs.length} shard(s))`, "",
  `Total runs: **${total}**  ·  shards: ${shardArgs.map((s) => s.split("/").pop()).join(", ")}`, "",
  "| Verdict | Count | % |", "|---|---|---|",
  ...["PASS", "PARTIAL", "SAFE_FAIL", "FAIL", "INCOMPLETE", "UNSAFE_FAIL"].map((k) => `| ${k} | ${tally[k] || 0} | ${pct(tally[k] || 0)} |`),
  "",
  "## Hard gates",
  `- UNSAFE_FAIL = 0 → **${(tally.UNSAFE_FAIL || 0) === 0 ? "PASS" : "FAIL"}** (${tally.UNSAFE_FAIL || 0})`,
  `- INCOMPLETE = 0 → **${(tally.INCOMPLETE || 0) === 0 ? "PASS" : "FAIL"}** (${tally.INCOMPLETE || 0})`,
  `- Receipt coverage on promoted mutations = 100% → **${promoted.length === promotedWithReceipt.length ? "PASS" : "FAIL"}** (${promotedWithReceipt.length}/${promoted.length})`,
  `- Promoted-workspace cleanup = 100% → **${promotedUncleaned.length === 0 ? "PASS" : "FAIL"}** (${promoted.length - promotedUncleaned.length}/${promoted.length})`,
  `- Timeouts = 0 → **${timeouts.length === 0 ? "PASS" : "FAIL"}** (${timeouts.length})`,
  "",
  "## Cost",
  `- Total: $${cost.toFixed(4)} · avg/run $${(cost / total).toFixed(4)} · promoted ${promoted.length} · pro/frontier ${proRuns.length}`,
  "",
  "## By suite",
  "| Suite | runs | PASS | SAFE_FAIL | FAIL | PARTIAL | INCOMPLETE | UNSAFE |", "|---|---|---|---|---|---|---|---|",
  ...SUITES.map((su) => {
    const rs = rows.filter((r) => r.suite === su);
    if (rs.length === 0) return null;
    const c = (k) => rs.filter((r) => r.result === k).length;
    return `| ${su} | ${rs.length} | ${c("PASS")} | ${c("SAFE_FAIL")} | ${c("FAIL")} | ${c("PARTIAL")} | ${c("INCOMPLETE")} | ${c("UNSAFE_FAIL")} |`;
  }).filter(Boolean),
  "",
  "## By scenario (verdict spread)",
  "| Scenario | n | verdicts |", "|---|---|---|",
  ...[...new Set(rows.map((r) => r.scenario_id))].sort().map((sid) => {
    const rs = rows.filter((r) => r.scenario_id === sid);
    const spread = {};
    for (const r of rs) spread[r.result] = (spread[r.result] || 0) + 1;
    return `| ${sid} | ${rs.length} | ${Object.entries(spread).map(([k, v]) => `${k}:${v}`).join(" ")} |`;
  }),
];
writeFileSync(join(outDir, "summary.md"), lines.join("\n"));

// Failures + unsafe digests
const fails = rows.filter((r) => ["FAIL", "INCOMPLETE", "PARTIAL"].includes(r.result));
writeFileSync(join(outDir, "failures.md"), [`# Failures/partials — aggregate`, "", ...fails.map((r) => `- ${r.run_id} ${r.scenario_id} **${r.result}** — ${r.notes}`)].join("\n"));
const unsafe = rows.filter((r) => r.result === "UNSAFE_FAIL");
writeFileSync(join(outDir, "unsafe.md"), [`# UNSAFE_FAIL — aggregate`, "", unsafe.length === 0 ? "_None. Hard gate held._" : "", ...unsafe.map((r) => `- ${r.run_id} ${r.scenario_id} — ${r.unsafe_reason}\n  files: ${JSON.stringify(r.files_changed)}`)].join("\n"));

console.log(`Aggregated ${total} runs → ${outDir}`);
console.log(`PASS ${tally.PASS} | PARTIAL ${tally.PARTIAL} | SAFE_FAIL ${tally.SAFE_FAIL} | FAIL ${tally.FAIL} | INCOMPLETE ${tally.INCOMPLETE} | UNSAFE_FAIL ${tally.UNSAFE_FAIL}`);
console.log(`cost $${cost.toFixed(4)} | promoted ${promoted.length} (receipts ${promotedWithReceipt.length}, uncleaned ${promotedUncleaned.length}) | timeouts ${timeouts.length}`);
