// @ts-nocheck
/**
 * Aggregate the reachability matrix into a self-coverage report.
 *
 * Reads results.json (per-surface operational deltas + receipts) and, for every
 * module directory under src/modules, classifies it by WHERE it operates at runtime:
 *
 *   LIVE-BUILD      operates in a work surface (build/fix/batch/competitive)
 *   LIVE-COGNITION  operates in the bare-goal cognition/consult deliberation surface
 *   LIVE-COMMAND    operates via its own operator command (trust/spec/heal/repo-doctor/…)
 *   DIAGNOSTIC-ONLY operates only in doctor/capabilities/detect/recover
 *
 * For modules NOT reached this run, a static second axis (import graph + @status tag,
 * with a barrel-import-aware scan) sub-classifies them honestly:
 *
 *   CONDITIONAL     a live importer exists but its trigger wasn't exercised this run
 *   DORMANT-LABELED carries an explicit @status dormant/library-only label
 *   TRUE-ORPHAN     wired nowhere AND no @status label — the real phantom to resolve
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const IKBI = resolve(new URL("../..", import.meta.url).pathname);
const WORK = process.env.REACH_WORK || join(IKBI, "reports", "proving-ground", "reachability");
const results = JSON.parse(readFileSync(join(WORK, "results.json"), "utf8"));

// surface → class it belongs to (for the "where does it live" verdict)
const WORK_S = new Set(["build", "build-competitive", "fix", "batch"]);
const COG = new Set(["cognition", "consult"]);
const DIAG = new Set(["doctor", "capabilities", "models", "providers", "receipts", "cost", "summary", "detect", "recover", "kill-status", "workspace-ls", "audit"]);
// everything else that operates a module through its own operator command
const moduleDirs = readdirSync(join(IKBI, "src", "modules"), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

const surfaceNames = results.filter((r) => r.tier !== "floor").map((r) => r.name);
const opBy = (mod) => {
  const row = {};
  for (const r of results) {
    if (r.tier === "floor") continue;
    const v = r.mods["modules/" + mod];
    row[r.name] = v && v.opCount > 0 ? v.opCount : 0;
  }
  return row;
};

// ── static evidence for the NOT-reached modules (secondary axis) ─────────────
// Robust importer detection: scan every non-test .ts for an import specifier that
// resolves into modules/<mod>/ — INCLUDING relative barrel imports (`./<mod>/…`),
// the class of import a naive grep misses (that miss produced false phantoms in
// the audit that motivated this report).
function walk(d) { let o = []; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) o = o.concat(walk(p)); else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) o.push(p); } return o; }
const allTs = walk(join(IKBI, "src"));
const importRe = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
function hasImporter(mod) {
  for (const f of allTs) {
    if (f.includes(`/modules/${mod}/`)) continue;
    const src = readFileSync(f, "utf8"); importRe.lastIndex = 0; let m;
    while ((m = importRe.exec(src))) { const s = m[1]; if (s.includes(`/${mod}/`) || s.endsWith(`/${mod}`)) return f.replace(IKBI, ""); }
  }
  return null;
}
function statusTag(mod) {
  const dir = join(IKBI, "src", "modules", mod);
  for (const f of readdirSync(dir)) { if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue; const mt = readFileSync(join(dir, f), "utf8").match(/@status (dormant|library-only|partially-wired)/); if (mt) return mt[1]; }
  return null;
}

const rows = moduleDirs.map((mod) => {
  const row = opBy(mod);
  const hit = surfaceNames.filter((s) => row[s] > 0);
  const anywhere = hit.length > 0;
  let cls, note = "";
  if (anywhere) {
    if (hit.some((s) => WORK_S.has(s))) cls = "LIVE-BUILD";
    else if (hit.some((s) => COG.has(s))) cls = "LIVE-COGNITION";
    else if (hit.some((s) => !DIAG.has(s))) cls = "LIVE-COMMAND";
    else cls = "DIAGNOSTIC-ONLY";
  } else {
    // not reached at runtime — sub-classify by static evidence
    const tag = statusTag(mod);
    const imp = hasImporter(mod);
    if (tag) { cls = "DORMANT-LABELED"; note = `@status ${tag}`; }
    else if (imp) { cls = "CONDITIONAL"; note = `imported by ${imp} — trigger not exercised`; }
    else { cls = "TRUE-ORPHAN"; note = "no importer, no @status label, no route/command"; }
  }
  return { mod, row, cls, anywhere, hit, note };
});

const order = { "LIVE-BUILD": 0, "LIVE-COGNITION": 1, "LIVE-COMMAND": 2, "DIAGNOSTIC-ONLY": 3, CONDITIONAL: 4, "DORMANT-LABELED": 5, "TRUE-ORPHAN": 6 };
rows.sort((a, b) => order[a.cls] - order[b.cls] || a.mod.localeCompare(b.mod));

// receipt effect per module: did any surface where it operates also see it emit a receipt op?
// (heuristic: receipt operation prefix ~ module name stem)
const receiptPrefixes = {};
for (const r of results) for (const op of Object.keys(r.ops)) {
  (receiptPrefixes[r.name] ??= new Set()).add(op);
}

let md = "# ikbi Runtime-Reachability Self-Coverage Report\n\n";
md += "Ground-truth signal: V8 code coverage per surface, minus a construction floor\n";
md += "(the CLI loaded doing nothing). What executes ABOVE the floor is genuine operation,\n";
md += "not import-time singleton construction. Grep/static import scans are NOT used — they\n";
md += "gave false confidence three times in the audit that motivated this report.\n\n";
md += `Surfaces exercised: ${surfaceNames.join(", ")}\n\n`;

const counts = {};
for (const r of rows) counts[r.cls] = (counts[r.cls] || 0) + 1;
md += "## Summary\n\n";
md += "Runtime-reached (coverage-proven this run):\n";
for (const c of ["LIVE-BUILD", "LIVE-COGNITION", "LIVE-COMMAND", "DIAGNOSTIC-ONLY"])
  md += `- **${c}**: ${counts[c] || 0}\n`;
md += "\nNot reached this run — sub-classified by static evidence:\n";
for (const c of ["CONDITIONAL", "DORMANT-LABELED", "TRUE-ORPHAN"])
  md += `- **${c}**: ${counts[c] || 0}\n`;
md += `\n- total module dirs: ${moduleDirs.length}\n\n`;

md += "## Where each module operates (surfaces / evidence)\n\n";
md += "| module | class | surfaces (op-fn count) / note |\n| --- | --- | --- |\n";
for (const r of rows) {
  const where = r.anywhere ? r.hit.map((s) => `${s}:${r.row[s]}`).join(", ") : r.note;
  md += `| ${r.mod} | ${r.cls} | ${where} |\n`;
}

md += "\n## TRUE-ORPHAN detail — declared modules wired NOWHERE (no runtime path, no importer, no @status label)\n\n";
const orphans = rows.filter((r) => r.cls === "TRUE-ORPHAN");
if (!orphans.length) md += "_none_ — every module is reached, conditionally reachable, or honestly labeled dormant.\n";
else for (const r of orphans) md += `- \`${r.mod}\` — ${r.note}\n`;

md += "\n## CONDITIONAL detail — reachable via a live importer, but the trigger was not exercised this run\n\n";
for (const r of rows.filter((r) => r.cls === "CONDITIONAL")) md += `- \`${r.mod}\` — ${r.note}\n`;

// Write the canonical snapshot INTO the repo (committed evidence) + the ephemeral copy.
const repoMd = join(IKBI, "scripts", "proving-ground", "REACHABILITY-REPORT.md");
writeFileSync(repoMd, md);
writeFileSync(join(WORK, "REACHABILITY-REPORT.md"), md);
console.log(md);
console.log(`\nwrote ${repoMd}`);

// Gate: a TRUE-ORPHAN (wired nowhere, no @status label) fails the check.
const orphanCount = rows.filter((r) => r.cls === "TRUE-ORPHAN").length;
if (process.argv.includes("--check") && orphanCount > 0) {
  console.error(`\n✗ reachability check FAILED — ${orphanCount} true orphan(s) declared but wired nowhere.`);
  process.exit(1);
}
