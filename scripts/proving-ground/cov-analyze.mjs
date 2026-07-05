// @ts-nocheck
/**
 * V8-coverage → module reachability analyzer.
 *
 * Reads a NODE_V8_COVERAGE directory and reports, per `dist/modules/<X>` and
 * `dist/core/<X>`, the SET of inner functions that actually executed (count>0).
 * This is the ground-truth "did it execute" signal — immune to the grep
 * false-confidence problem that fooled three static audits.
 *
 * Construction noise (constructors + config loaders that fire at barrel import)
 * is removed by the caller via baseline subtraction: run the CLI doing nothing,
 * capture that floor, and subtract it from each surface. What executes ABOVE the
 * floor is genuine operation, not import-time singleton construction.
 *
 * Returns Map<moduleKey, {fns:Set<fnId>, loaded:bool}> where fnId is
 * `relpath::functionName::rangeStart` (stable within a build).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function analyzeCoverageDir(covDir) {
  const mods = new Map();
  for (const f of readdirSync(covDir)) {
    if (!f.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(covDir, f), "utf8"));
    } catch {
      continue;
    }
    for (const script of data.result ?? []) {
      const url = script.url;
      if (!url || !url.startsWith("file:")) continue;
      const path = fileURLToPath(url);
      const m = path.match(/\/dist\/(modules|core)\/([^/]+)\//);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      const rel = path.split("/dist/")[1];
      if (!mods.has(key)) mods.set(key, { fns: new Set(), loaded: false });
      const rec = mods.get(key);
      const fns = script.functions ?? [];
      fns.forEach((fn, i) => {
        const ran = (fn.ranges ?? []).some((r) => r.count > 0);
        if (!ran) return;
        if (i === 0) {
          rec.loaded = true;
          return; // top-level wrapper = mere load, never counted as operation
        }
        if (!fn.functionName) return; // anonymous closures: skip (noisy, unstable)
        const start = fn.ranges?.[0]?.startOffset ?? 0;
        rec.fns.add(`${rel}::${fn.functionName}::${start}`);
      });
    }
  }
  return mods;
}

/** operational fns in `surface` that did NOT fire in `baseline` (construction floor). */
export function operationalDelta(surfaceMods, baselineMods) {
  const out = new Map();
  for (const [key, rec] of surfaceMods) {
    const base = baselineMods.get(key)?.fns ?? new Set();
    const opFns = [...rec.fns].filter((id) => !base.has(id));
    out.set(key, { loaded: rec.loaded, opFns, opCount: opFns.length });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [covDir, baseDir] = process.argv.slice(2);
  const surface = analyzeCoverageDir(covDir);
  const base = baseDir ? analyzeCoverageDir(baseDir) : new Map();
  const delta = operationalDelta(surface, base);
  for (const [key, r] of [...delta].sort((a, b) => b[1].opCount - a[1].opCount)) {
    if (!key.startsWith("modules/")) continue;
    const state = r.opCount > 0 ? "OPERATED" : r.loaded ? "constructed-only" : "-";
    console.log(`${state.padEnd(17)} ${key.padEnd(30)} op:${r.opCount}`);
  }
}
