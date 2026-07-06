// @ts-nocheck
/**
 * ikbi runtime FREQUENCY analyzer — the second dimension of runtime truth.
 *
 * Reachability answers "was it executed (in ANY surface)?" — a binary. FREQUENCY answers
 * "how OFTEN / how BROADLY is it used?" by aggregating the per-surface operational matrix the
 * reachability harness already produces (results.json). For each `modules/<X>` it reports:
 *   - hits / total  — in how many of the N exercised surfaces it OPERATED (opCount > 0)
 *   - freq          — hits / total (the breadth-of-use rate)
 *   - band          — ubiquitous | common | narrow | single | unused (see `band`)
 *   - maxOp / avgOp — operational-fn INTENSITY across the surfaces it hit
 *
 * The payoff is telemetry like "project-index operated in 6/8 surfaces (common), avg 40 op-fns"
 * vs "labmem-recall operated in 1/8 (single)". A `single`/`unused` module is a candidate for the
 * influence + value(ablation) dimensions — narrow use is the first hint a module may not earn its
 * place. PURE over results.json (no re-run, no coverage) — unit-tested with synthetic matrices.
 *
 * The dimensions of runtime truth, in order of depth:
 *   1. reachability (cov-analyze/reach-report) — was it executed?          [DONE]
 *   2. FREQUENCY (this file)                    — how often / how broadly?  [DONE]
 *   3. influence (influence.mjs)                — did it change a decision? [DONE]
 *   4. value / ablation (ablate-drift)          — would the outcome change? [DONE for drift]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Breadth band from the surface hit ratio. `single` (exactly one surface) is called out ahead of
 *  `common`/`narrow` because "used in exactly one place" is the sharpest narrow-use signal. */
export function band(hits, total) {
  if (hits <= 0) return "unused";
  if (total > 0 && hits === total) return "ubiquitous";
  if (hits === 1) return "single";
  if (total > 0 && hits / total >= 0.5) return "common";
  return "narrow";
}

/**
 * Compute the frequency dimension from a reachability `results.json` array. Each element is a
 * surface `{ name, tier, mods }` where `mods["modules/<X>"] = { opCount, ... }` is that surface's
 * operational delta. Floor surfaces (the construction baseline) are excluded. PURE — no I/O.
 */
export function computeFrequency(results) {
  const surfaces = (results ?? []).filter((r) => r && r.tier !== "floor");
  const total = surfaces.length;
  const keys = new Set();
  for (const s of surfaces) for (const k of Object.keys(s.mods ?? {})) if (k.startsWith("modules/")) keys.add(k);

  const rows = [];
  for (const key of keys) {
    const mod = key.slice("modules/".length);
    const perSurface = surfaces.map((s) => ({ name: s.name, op: (s.mods?.[key]?.opCount) || 0 }));
    const hitSurfaces = perSurface.filter((x) => x.op > 0);
    const opCounts = hitSurfaces.map((x) => x.op);
    const maxOp = opCounts.length ? Math.max(...opCounts) : 0;
    const avgOp = opCounts.length ? Math.round((opCounts.reduce((a, b) => a + b, 0) / opCounts.length) * 10) / 10 : 0;
    rows.push({
      mod,
      hits: hitSurfaces.length,
      total,
      freq: total > 0 ? hitSurfaces.length / total : 0,
      band: band(hitSurfaces.length, total),
      maxOp,
      avgOp,
      surfaces: hitSurfaces.map((x) => x.name),
    });
  }
  // Most-used first (freq, then intensity), so the report reads core → periphery.
  rows.sort((a, b) => b.freq - a.freq || b.maxOp - a.maxOp || a.mod.localeCompare(b.mod));
  return { total, rows };
}

/** Render the frequency report as markdown. */
export function renderFrequencyReport(freq, surfaceNames) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const counts = {};
  for (const r of freq.rows) counts[r.band] = (counts[r.band] || 0) + 1;
  let md = "# ikbi Runtime FREQUENCY Report\n\n";
  md += "The second dimension of runtime truth (after reachability): not just *was* a module executed,\n";
  md += "but in HOW MANY of the exercised surfaces, and how INTENSELY. Aggregated from the per-surface\n";
  md += "operational matrix (V8 coverage minus a construction floor) — no grep, no static guesses.\n\n";
  md += `Surfaces aggregated (${freq.total}): ${surfaceNames.join(", ")}\n\n`;
  md += "## Bands\n\n";
  md += "- **ubiquitous** — operates in EVERY exercised surface (core infrastructure)\n";
  md += "- **common** — operates in ≥ half the surfaces\n";
  md += "- **narrow** — operates in several surfaces but < half\n";
  md += "- **single** — operates in exactly ONE surface (a candidate for influence/ablation scrutiny)\n";
  md += "- **unused** — loaded this run but operated in no surface (0 op-fns above the floor)\n\n";
  for (const b of ["ubiquitous", "common", "narrow", "single", "unused"]) md += `- ${b}: ${counts[b] || 0}\n`;
  md += "\n## Per-module frequency + intensity\n\n";
  md += "| module | band | surfaces | freq | maxOp | avgOp | where |\n| --- | --- | --- | --- | --- | --- | --- |\n";
  for (const r of freq.rows) {
    md += `| ${r.mod} | ${r.band} | ${r.hits}/${r.total} | ${pct(r.freq)} | ${r.maxOp} | ${r.avgOp} | ${r.surfaces.join(", ") || "—"} |\n`;
  }
  return md;
}

// CLI: read results.json from the reachability WORK dir, compute + write FREQUENCY-REPORT.md.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const IKBI = resolve(new URL("../..", import.meta.url).pathname);
  const WORK = process.env.REACH_WORK || join(IKBI, "reports", "proving-ground", "reachability");
  const results = JSON.parse(readFileSync(join(WORK, "results.json"), "utf8"));
  const surfaceNames = results.filter((r) => r.tier !== "floor").map((r) => r.name);
  const freq = computeFrequency(results);
  const md = renderFrequencyReport(freq, surfaceNames);
  const repoMd = join(IKBI, "scripts", "proving-ground", "FREQUENCY-REPORT.md");
  writeFileSync(repoMd, md);
  writeFileSync(join(WORK, "FREQUENCY-REPORT.md"), md);
  console.log(md);
  console.log(`\nwrote ${repoMd}`);
}
