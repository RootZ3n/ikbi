// @ts-nocheck
/**
 * ikbi runtime-reachability / self-coverage harness.
 *
 * Answers the phantom-integration question by EVIDENCE, not grep: for each
 * operator SURFACE, run a real scenario against `dist/` under V8 coverage in
 * isolated state, then subtract a construction floor (the CLI loaded doing
 * nothing) to separate genuine OPERATION from import-time singleton construction.
 *
 * A declared engine module that OPERATES in no surface is a PHANTOM — declared /
 * tested but never executed in any live flow. A module that operates only in the
 * `doctor`/enumeration surfaces is DIAGNOSTIC-ONLY (never on a work path).
 *
 * Runs against dist (not tsx) so coverage URLs map 1:1 to src/modules/<X>.
 * Shells out to the real CLI — never imports engine internals.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeCoverageDir, operationalDelta } from "./cov-analyze.mjs";

const IKBI_DIR = resolve(new URL("../..", import.meta.url).pathname);
const CLI = join(IKBI_DIR, "dist", "cli", "index.js");
const REAL_PROVIDERS = join(homedir(), ".ikbi", "state", "providers.json");
const WORK = process.env.REACH_WORK || join(IKBI_DIR, "reports", "proving-ground", "reachability");

// ── fixtures ────────────────────────────────────────────────────────────────
// Plain-JS, zero-dependency projects: `run_checks` uses the built-in `node --test`
// so a build can actually go GREEN and promote without installing a toolchain
// (that is what covers the critic + integrator + promote path).
function commit(dir, msg) {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=reach", "commit", "-qm", msg], { cwd: dir });
}
function greenfieldJs(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "reachfix", version: "0.1.0", type: "module",
    scripts: { test: "node --test" },
  }, null, 2));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  commit(dir, "init");
}
function brokenJs(dir) {
  greenfieldJs(dir);
  // a failing test so `ikbi fix` has a red check to diagnose + repair
  writeFileSync(join(dir, "src", "sum.js"), "export const sum = (a, b) => a - b; // BUG: should add\n");
  writeFileSync(join(dir, "src", "sum.test.js"),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from './sum.js';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  commit(dir, "broken");
}

// ── surface catalog ─────────────────────────────────────────────────────────
// tier: "free" (no model call) | "paid" (spends model tokens)
const SURFACES = [
  { name: "baseline", tier: "floor", argv: () => ["version"] },
  // free / no-model surfaces
  { name: "doctor", tier: "free", argv: () => ["doctor"] },
  { name: "capabilities", tier: "free", argv: () => ["capabilities"] },
  { name: "models", tier: "free", argv: () => ["models"] },
  { name: "providers", tier: "free", argv: () => ["providers"] },
  { name: "receipts", tier: "free", argv: () => ["receipts", "--limit", "5"] },
  { name: "cost", tier: "free", argv: () => ["cost"] },
  { name: "summary", tier: "free", argv: () => ["summary"] },
  { name: "detect", tier: "free", argv: () => ["detect", "--repo", IKBI_DIR, "--json"] },
  { name: "recover", tier: "free", argv: () => ["recover", "build", "--json"] },
  { name: "kill-status", tier: "free", argv: () => ["kill-status"] },
  { name: "workspace-ls", tier: "free", argv: () => ["workspace", "list"] },
  { name: "audit", tier: "free", argv: () => ["audit"] },
  { name: "classify", tier: "free", argv: () => ["classify", "fix the failing build check"] },
  // paid / model surfaces
  {
    name: "build", tier: "paid", timeoutMs: 300000,
    prep: greenfieldJs,
    argv: (dir) => ["build", "create src/add.js exporting a pure function add(a, b) that returns a + b, plus src/add.test.js using node:test asserting add(2, 3) === 5", "--repo", dir, "--yes", "--max-budget-usd", "3", "--json"],
  },
  {
    name: "fix", tier: "paid", timeoutMs: 300000,
    prep: brokenJs,
    argv: (dir) => ["fix", dir, "--json"],
  },
  {
    name: "cognition", tier: "paid", timeoutMs: 180000,
    argv: () => ["add a retry helper with exponential backoff to the http client"],
  },
  {
    name: "batch", tier: "paid", timeoutMs: 300000,
    prep: greenfieldJs,
    argv: (dir) => ["batch", "add two small pure util functions each in its own file under src/, each with a node:test", "--repo", dir, "--yes", "--max-budget-usd", "3", "--json"],
  },
  // extra command surfaces — exercise every phantom-candidate operator command
  { name: "trust-status", tier: "extra", argv: () => ["trust", "status", "worker"] },
  { name: "spec-create", tier: "extra", argv: () => ["spec", "create", "add a retry helper with exponential backoff"] },
  { name: "spec-list", tier: "extra", argv: () => ["spec", "list"] },
  { name: "job-cards", tier: "extra", argv: () => ["job-cards", "list"] },
  { name: "memory", tier: "extra", argv: () => ["memory", "stats"] },
  { name: "agents", tier: "extra", argv: () => ["agents", "--repo", IKBI_DIR] },
  { name: "repos", tier: "extra", argv: () => ["repos"] },
  { name: "monitor", tier: "extra", argv: () => ["monitor"] },
  { name: "health", tier: "extra", argv: () => ["health", "--repo", IKBI_DIR, "--json"] },
  { name: "doctor-selfrepair", tier: "extra", argv: () => ["doctor", "--self-repair"] },
  { name: "heal", tier: "extra", argv: () => ["heal"] },
  { name: "evaluate", tier: "extra", argv: () => ["evaluate", "--json"] },
  // competitive build → deterministic-judge scores candidates
  {
    name: "build-competitive", tier: "paid", timeoutMs: 300000,
    prep: greenfieldJs, env: { IKBI_WORKER_MODEL_COMPETITIVE: "1", IKBI_WORKER_MODEL_COMPETITIVE_N: "2" },
    argv: (dir) => ["build", "create src/mul.js exporting a pure function mul(a, b) returning a * b, plus src/mul.test.js using node:test asserting mul(2, 3) === 6", "--repo", dir, "--yes", "--max-budget-usd", "4", "--json"],
  },
  { name: "consult", tier: "paid", timeoutMs: 120000, argv: () => ["consult", "what retry strategy should an http client use?"] },
  // HTTP server surface — in-process buildServer + inject at the module route seams
  { name: "server", tier: "extra", probe: join(IKBI_DIR, "scripts", "proving-ground", "server-probe.mjs") },
];

function runSurface(s) {
  const base = join(WORK, s.name);
  const covDir = join(base, "cov");
  const stateRoot = join(base, "state");
  const fixture = join(base, "repo");
  for (const d of [covDir, stateRoot, join(stateRoot, "receipts")]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
  cpSync(REAL_PROVIDERS, join(stateRoot, "providers.json"));
  let cwd = IKBI_DIR;
  if (s.prep) { rmSync(fixture, { recursive: true, force: true }); mkdirSync(fixture, { recursive: true }); s.prep(fixture); }
  const argv = s.probe ? [s.probe] : s.argv(fixture);
  const env = { ...process.env, IKBI_STATE_ROOT: stateRoot, IKBI_LOG_LEVEL: "silent", NODE_V8_COVERAGE: covDir, ...(s.env || {}) };
  const t0 = Date.now();
  const r = spawnSync("node", s.probe ? [s.probe] : [CLI, ...argv], { cwd, env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: s.timeoutMs ?? 60000 });
  const ms = Date.now() - t0;
  // receipts fired this surface
  const rpath = join(stateRoot, "receipts", "receipts.ndjson");
  const ops = {};
  if (existsSync(rpath)) {
    for (const line of readFileSync(rpath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const op = JSON.parse(line).operation; ops[op] = (ops[op] || 0) + 1; } catch {}
    }
  }
  const mods = analyzeCoverageDir(covDir);
  return { name: s.name, tier: s.tier, ms, exit: r.status, timedOut: r.signal === "SIGTERM", ops, mods, argv };
}

// ── main ────────────────────────────────────────────────────────────────────
const want = process.argv.slice(2); // surface names to run, or "free"/"paid"/"all"
let queue = SURFACES;
if (want.length && want[0] !== "all") {
  if (want[0] === "free") queue = SURFACES.filter((s) => s.tier === "free" || s.tier === "floor");
  else if (want[0] === "paid") queue = SURFACES.filter((s) => s.tier === "paid" || s.tier === "floor");
  else if (want[0] === "extra") queue = SURFACES.filter((s) => s.tier === "extra" || s.tier === "floor");
  else queue = SURFACES.filter((s) => want.includes(s.name) || s.tier === "floor");
}
// floor must run first
queue = [...queue].sort((a, b) => (a.tier === "floor" ? -1 : b.tier === "floor" ? 1 : 0));

mkdirSync(WORK, { recursive: true });
const results = [];
let floor = new Map();
for (const s of queue) {
  process.stderr.write(`▶ ${s.name} … `);
  const res = runSurface(s);
  if (s.tier === "floor") floor = res.mods;
  results.push(res);
  const opMods = [...operationalDelta(res.mods, floor)].filter(([k, v]) => k.startsWith("modules/") && v.opCount > 0).length;
  process.stderr.write(`exit=${res.exit}${res.timedOut ? " TIMEOUT" : ""} ${res.ms}ms  op-modules=${opMods}  receipts=${Object.values(res.ops).reduce((a, b) => a + b, 0)}\n`);
}

// persist raw for aggregation — MERGE by surface name so batches accumulate.
const outPath = join(WORK, "results.json");
const serial = results.map((r) => ({
  name: r.name, tier: r.tier, ms: r.ms, exit: r.exit, timedOut: r.timedOut, ops: r.ops, argv: r.argv,
  mods: Object.fromEntries([...operationalDelta(r.mods, floor)].map(([k, v]) => [k, { loaded: v.loaded, opCount: v.opCount, opFns: v.opFns }])),
}));
let prior = [];
try { prior = JSON.parse(readFileSync(outPath, "utf8")); } catch {}
const byName = new Map(prior.map((r) => [r.name, r]));
for (const r of serial) byName.set(r.name, r);
writeFileSync(outPath, JSON.stringify([...byName.values()], null, 2));
process.stderr.write(`\nwrote ${outPath}\n`);
