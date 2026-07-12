// @ts-nocheck
/**
 * ikbi RUNTIME-TRUTH roll-up — one command that characterizes a single receipt corpus across the
 * receipt-based dimensions of runtime truth, so a fresh `ikbi build` can be graded end-to-end.
 *
 * The four dimensions live in separate analyzers (reachability/frequency read V8 coverage +
 * results.json; influence + value read receipts). This roll-up composes the two RECEIPT-based ones
 * over a single `receipts.ndjson` — no re-derivation, it imports their PURE exports:
 *   • influence (influence.mjs)          — did each decision module STEER? (pivotal/active/passive/latent)
 *   • value/ablation (ablate-gate-wall)  — for the passive gate, would ablating it change anything?
 *
 * Output: a per-decision-module table (presence → steering → value in one row) + the gate-wall
 * ablation verdict, written to RUNTIME-TRUTH.md. Point it at a build's state receipts:
 *   node scripts/proving-ground/runtime-truth.mjs <path/to/receipts.ndjson>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeInfluence } from "./influence.mjs";
import { analyzeGateConstancy, gateScenarios, runScenario } from "./ablate-gate-wall.mjs";

/** Parse a receipts.ndjson into an array (skips blank/corrupt lines). */
export function loadReceipts(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/**
 * Compose the receipt-based dimensions into a single roll-up. PURE over parsed receipts (the gate
 * ablation PART B is injected so this stays pure + testable; the CLI passes the real dist gate).
 */
export function computeRuntimeTruth(receipts, gateAblation) {
  const influence = computeInfluence(receipts);
  const gateConstancy = analyzeGateConstancy(receipts);
  return {
    totalReceipts: Array.isArray(receipts) ? receipts.length : 0,
    decisionReceipts: influence.decisionReceipts,
    influence,
    gateConstancy,
    gateAblation: gateAblation ?? null, // PART B rows [{name,onAllow,offAllow,outcomeDiffers,...}] or null
  };
}

/** Render the combined roll-up markdown. */
export function renderRuntimeTruth(rt, source) {
  let md = "# ikbi RUNTIME-TRUTH roll-up\n\n";
  md += "Presence → steering → value for every decision module, from one receipt corpus.\n\n";
  if (source) md += `Source: ${source}\n\n`;
  md += `Receipts: **${rt.totalReceipts}** (${rt.decisionReceipts} decision-bearing)\n\n`;

  md += "## Decision modules (influence)\n\n";
  md += "| module | steering band | decisions | interventions | rate |\n| --- | --- | --- | --- | --- |\n";
  for (const r of rt.influence.rows) {
    md += `| ${r.module} | ${r.band} | ${r.decisions} | ${r.interventions} | ${Math.round(r.rate * 100)}% |\n`;
  }

  md += "\n## Value probe — gate-wall (the passive one)\n\n";
  const gc = rt.gateConstancy;
  md += `- gate evaluations: **${gc.evaluations}**  ·  denies: **${gc.denies}**  ·  allow cause: ${gc.bypassDriven} bypass, ${gc.tierPermitted} tier-permitted\n`;
  md += `- realized value: **${gc.realizedValue}**\n`;
  if (rt.gateAblation) {
    const teeth = rt.gateAblation.filter((r) => r.outcomeDiffers);
    md += `- structural teeth (deterministic A/B): **${teeth.length}/${rt.gateAblation.length}** — `;
    md += (teeth.map((r) => r.name).join("; ") || "none") + "\n";
  }

  md += "\n## One-line verdict\n\n";
  const pivotal = rt.influence.rows.filter((r) => r.band === "pivotal").map((r) => r.module.replace(/^.*\//, ""));
  const passive = rt.influence.rows.filter((r) => r.band === "passive").map((r) => r.module.replace(/^.*\//, ""));
  const latent = rt.influence.rows.filter((r) => r.band === "latent").map((r) => r.module.replace(/^.*\//, ""));
  md += `Pivotal (steered outcomes): **${pivotal.join(", ") || "none"}**. `;
  md += `Passive (authority, never bit here): **${passive.join(", ") || "none"}**. `;
  md += `Latent (no decisions this corpus): **${latent.join(", ") || "none"}**.\n`;
  return md;
}

// CLI: roll up a receipts.ndjson, running the real dist gate for the ablation PART B.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const IKBI = resolve(new URL("../..", import.meta.url).pathname);
  const arg = process.argv[2];
  const source = arg
    ? resolve(arg)
    : (process.env.IKBI_STATE_ROOT
        ? join(process.env.IKBI_STATE_ROOT, "receipts", "receipts.ndjson")
        : join(IKBI, "state", "receipts", "receipts.ndjson"));
  if (!existsSync(source)) {
    console.error(`no receipts at ${source} — pass a receipts.ndjson path or set IKBI_STATE_ROOT`);
    process.exit(1);
  }
  const receipts = loadReceipts(source);

  // real gate ablation PART B (deterministic, free)
  const { createGateWall } = await import(join(IKBI, "dist", "modules", "gate-wall", "gate.js"));
  const gateOn = createGateWall({ config: { enabled: true, bypass: false }, receipts: { append: async () => {} }, publish: () => {}, newGateId: () => "on" });
  const gateOff = { evaluate: async () => ({ allow: true, reason: "ablated" }) };
  const identity = { agentId: "worker", trustTier: "operator" };
  const gateAblation = [];
  for (const sc of gateScenarios()) gateAblation.push(await runScenario(sc, gateOn, gateOff, identity));

  const rt = computeRuntimeTruth(receipts, gateAblation);
  const md = renderRuntimeTruth(rt, source.replace(IKBI + "/", ""));
  const repoMd = join(IKBI, "scripts", "proving-ground", "RUNTIME-TRUTH.md");
  writeFileSync(repoMd, md);
  console.log(md);
  console.log(`\nwrote ${repoMd}`);
}
