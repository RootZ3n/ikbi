// @ts-nocheck
/**
 * Prevented-attempt risk telemetry — read-only summary over `worker.run.summary` receipts.
 *
 * The effect-based promote gate no longer discards a build for a PREVENTED (governor-blocked) policy
 * attempt, but it RECORDS each one on the run summary (preventedCount + preventedCommands). This tool
 * aggregates that across builds so risk thresholds / a future trust delta can be designed from
 * EVIDENCE — "which prevented behaviours are normal cheap-model noise vs. patterns that predict bad
 * outcomes?" — WITHOUT paying for a dedicated observation campaign. Evidence accrues on normal usage.
 *
 *   node scripts/proving-ground/risk-telemetry.mjs [<receipts.ndjson> ...]
 *   # defaults to ~/.ikbi/state/receipts/receipts.ndjson + /lab-fake/ikbi-*-state/receipts/receipts.ndjson
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultPaths() {
  const out = [join(homedir(), ".ikbi", "state", "receipts", "receipts.ndjson")];
  try {
    for (const d of readdirSync("/lab-fake")) {
      if (/^ikbi-.*-state$/.test(d)) out.push(join("/lab-fake", d, "receipts", "receipts.ndjson"));
    }
  } catch {}
  return out.filter(existsSync);
}

const paths = process.argv.slice(2).length ? process.argv.slice(2) : defaultPaths();
const runs = [];
for (const p of paths) {
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.operation !== "worker.run.summary") continue;
    const m = r.metadata ?? {};
    runs.push({
      taskId: m.taskId, promoted: m.promoted === true, outcome: m.outcome,
      preventedCount: typeof m.preventedCount === "number" ? m.preventedCount : 0,
      preventedCommands: Array.isArray(m.preventedCommands) ? m.preventedCommands : [],
      requiresReview: m.requiresReview === true,
      verification: m.verificationResult,
    });
  }
}

if (runs.length === 0) { console.log("no worker.run.summary receipts found in:", paths.join(", ")); process.exit(0); }

const withPrevented = runs.filter((r) => r.preventedCount > 0);
const promoted = (rs) => rs.filter((r) => r.promoted).length;
const cmdHist = {};
for (const r of withPrevented) for (const c of r.preventedCommands) {
  const bin = c.split(":")[0] + (c.includes("node -e") || /node .*-e/.test(c) ? " (node -e)" : c.includes("rm ") ? " (rm)" : "");
  cmdHist[bin] = (cmdHist[bin] || 0) + 1;
}

console.log(`# Prevented-attempt risk telemetry — ${runs.length} build(s) across ${paths.length} receipt log(s)\n`);
console.log(`Builds with >=1 prevented attempt : ${withPrevented.length}/${runs.length} (${Math.round((withPrevented.length / runs.length) * 100)}%)`);
console.log(`Max prevented attempts in one run : ${runs.reduce((m, r) => Math.max(m, r.preventedCount), 0)}`);
console.log(`Held for review (over threshold)  : ${runs.filter((r) => r.requiresReview).length}`);
console.log("");
console.log(`Promote rate — ALL builds         : ${promoted(runs)}/${runs.length}`);
console.log(`Promote rate — builds WITH a prevented attempt : ${promoted(withPrevented)}/${withPrevented.length}`);
console.log(`Promote rate — builds with NONE   : ${promoted(runs.filter((r) => r.preventedCount === 0))}/${runs.filter((r) => r.preventedCount === 0).length}`);
console.log("\nDoes a prevented attempt predict non-promote? Compare the two rates above — if similar,");
console.log("prevented attempts are NOISE, not a bad-outcome predictor (don't wire a trust delta off count).");
console.log("\nPrevented command shapes (histogram):");
for (const [k, v] of Object.entries(cmdHist).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
if (Object.keys(cmdHist).length === 0) console.log("  (none recorded yet — accrues as builds run)");
