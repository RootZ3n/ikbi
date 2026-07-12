// Synthetic unit tests for the runtime FREQUENCY analyzer. Free + instant (no coverage run).
// Run: node scripts/proving-ground/frequency.test.mjs
import { band, computeFrequency } from "./frequency.mjs";

// A synthetic reachability results.json: a construction floor + 4 real surfaces. Each surface's
// `mods` carries the operational delta (opCount per module key). We craft modules that land in
// each band deliberately.
const RESULTS = [
  { name: "floor", tier: "floor", mods: {} },
  { name: "build",  tier: "work", mods: { "modules/worker-model": { opCount: 120 }, "modules/project-index": { opCount: 40 }, "modules/gate-wall": { opCount: 8 }, "modules/scope-plan": { opCount: 5 } } },
  { name: "fix",    tier: "work", mods: { "modules/worker-model": { opCount: 90 },  "modules/project-index": { opCount: 30 }, "modules/gate-wall": { opCount: 6 } } },
  { name: "batch",  tier: "work", mods: { "modules/worker-model": { opCount: 60 },  "modules/project-index": { opCount: 0 },  "modules/batch-planner": { opCount: 15 } } },
  { name: "doctor", tier: "diag", mods: { "modules/worker-model": { opCount: 3 },   "modules/labmem-recall": { opCount: 2 } } },
];

const { total, rows } = computeFrequency(RESULTS);
const by = Object.fromEntries(rows.map((r) => [r.mod, r]));

const cases = [
  // 4 non-floor surfaces are aggregated; the floor is excluded.
  ["total surfaces excludes floor", () => total === 4],
  // worker-model operates in all 4 → ubiquitous, freq 100%, maxOp 120.
  ["worker-model ubiquitous", () => by["worker-model"].band === "ubiquitous" && by["worker-model"].hits === 4 && by["worker-model"].maxOp === 120],
  // project-index: build + fix (opCount>0), batch is 0 → 2/4 → common (>= half).
  ["project-index common (2/4)", () => by["project-index"].band === "common" && by["project-index"].hits === 2],
  // gate-wall: build + fix → 2/4 → common.
  ["gate-wall common", () => by["gate-wall"].band === "common"],
  // batch-planner: only batch → single.
  ["batch-planner single", () => by["batch-planner"].band === "single" && by["batch-planner"].hits === 1],
  // scope-plan: only build → single.
  ["scope-plan single", () => by["scope-plan"].band === "single"],
  // labmem-recall: only doctor → single (and narrowly used — the influence/ablation candidate).
  ["labmem-recall single", () => by["labmem-recall"].band === "single" && by["labmem-recall"].surfaces[0] === "doctor"],
  // avgOp is the mean over HIT surfaces only (project-index: (40+30)/2 = 35, not diluted by the 0).
  ["avgOp over hit surfaces only", () => by["project-index"].avgOp === 35],
  // rows are sorted most-used first: worker-model (100%) leads.
  ["sorted most-used first", () => rows[0].mod === "worker-model"],
  // band() edge cases.
  ["band unused", () => band(0, 4) === "unused"],
  ["band ubiquitous", () => band(4, 4) === "ubiquitous"],
  ["band single beats common at 1/2", () => band(1, 2) === "single"],
  ["band narrow (2/5)", () => band(2, 5) === "narrow"],
  ["band common (3/5)", () => band(3, 5) === "common"],
];

let ok = 0;
for (const [name, fn] of cases) {
  let pass = false;
  try { pass = fn() === true; } catch (e) { pass = false; }
  if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${name}`);
}
console.log(`\n${ok}/${cases.length} frequency cases pass`);
process.exit(ok === cases.length ? 0 : 1);
