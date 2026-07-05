// @ts-nocheck
/**
 * VALUE-dimension ablation for drift-prevention (the 4th proving-ground dimension:
 * "would the outcome change if this module didn't exist?").
 *
 * Reachability proved drift.check() EXECUTES on the build/cognition path. It does not
 * prove drift MATTERS. Drift's ONLY causal path to any outcome is a text note it appends
 * to the cognition deliberation prompt (cognition.ts: `driftNote`). So we ablate at that
 * seam and measure whether the outcome changes.
 *
 * Two measurements:
 *   PART A — realistic value: in the state real builds run in (fresh/greenfield, no
 *     `pattern` baseline), does drift emit ANYTHING? If check() returns [] the note is
 *     empty and drift's influence is provably zero there.
 *   PART B — best-case value: inject drift's MAXIMAL signal (a major reliability drop) as
 *     the ON arm vs an empty OFF arm (== drift removed), hold goal/model/memory fixed, run
 *     N real deliberations each, and compare the decisions. This is drift at its most
 *     influential; if the decision distribution doesn't move, drift changes nothing even
 *     at full strength.
 *
 * Imports the module barrel first (egress guard + provider registry) exactly like the
 * real CLI. Makes real model calls — costs a little (2N cognition calls).
 */
import { pino } from "pino";

import "../../dist/modules/index.js";
import { createCognitionLayer } from "../../dist/modules/cognition-layer/cognition.js";
import { driftPrevention } from "../../dist/modules/drift-prevention/index.js";
import { IdentityResolver, beginOperation } from "../../dist/core/identity/resolver.js";
import { AgentRegistry, hashToken } from "../../dist/core/identity/registry.js";

const N = Number(process.env.ABLATE_N || 8);
const AGENT = "worker";
const PROJECT = "ablation-demo";
const GOAL =
  "The build for this project keeps failing on flaky checks. Decide the single next step and which module should handle it.";

function validatedCtx(agentId) {
  const resolver = new IdentityResolver({
    registry: new AgentRegistry({ agents: [{ agentId, kind: "agent", defaultTrustTier: "trusted", tokenHashes: [hashToken(`${agentId}-secret`)] }] }),
    logger: pino({ level: "silent" }),
    now: () => 1000,
  });
  return beginOperation(resolver.resolve({ token: `${agentId}-secret` }), { requestId: "ablate-1" });
}

const emptyLabMemory = { byProject: async () => [] };
const driftOff = { check: async () => [] }; // drift REMOVED (ablated)
const DRIFTED = {
  agent: AGENT, operation: "build", project: PROJECT,
  baselineRate: 0.9, recentRate: 0.3, drop: 0.6, sampleSize: 20,
  drifted: true, severity: "major", reason: "recent build success 30% vs 90% baseline", action: "none",
};
const driftOn = { check: async () => [DRIFTED] }; // drift at MAXIMAL signal

const mkLayer = (drift) => createCognitionLayer({ labMemory: emptyLabMemory, drift, publish: () => {} });

function tally(rows) {
  const modules = {};
  let confSum = 0, n = 0;
  for (const r of rows) {
    const key = r.module ?? "(none)";
    modules[key] = (modules[key] || 0) + 1;
    if (typeof r.confidence === "number") { confSum += r.confidence; n += 1; }
  }
  return { modules, avgConfidence: n ? +(confSum / n).toFixed(3) : null };
}

async function runArm(label, drift) {
  const ctx = validatedCtx(AGENT);
  const layer = mkLayer(drift);
  const rows = [];
  for (let i = 0; i < N; i += 1) {
    try {
      const d = await layer.deliberate({ parentCtx: ctx, goal: GOAL, project: PROJECT });
      rows.push({ module: d.recommendedNext?.module, action: d.recommendedNext?.action, decision: d.decision, confidence: d.confidence });
    } catch (e) {
      rows.push({ module: "(error)", decision: String(e?.message ?? e), confidence: null });
    }
    process.stderr.write(`  ${label} ${i + 1}/${N} → ${rows[i].module ?? "(none)"} conf=${rows[i].confidence ?? "?"}\n`);
  }
  return rows;
}

// ── PART A: realistic value (does drift emit anything in fresh state?) ──────────
process.stderr.write("PART A — realistic value (fresh state, real drift detector):\n");
const realCheck = await driftPrevention.check({ agent: AGENT, project: PROJECT });
process.stderr.write(`  drift.check() on fresh state returned ${realCheck.length} report(s) → note would be ${realCheck.length ? "NON-EMPTY" : "EMPTY (zero influence)"}\n\n`);

// ── PART B: best-case value (A/B the maximal drift signal) ─────────────────────
process.stderr.write(`PART B — best-case value (${N} real deliberations per arm):\n`);
const off = await runArm("OFF", driftOff);
const on = await runArm("ON ", driftOn);

const offT = tally(off), onT = tally(on);
const report = {
  goal: GOAL,
  partA: { freshStateReports: realCheck.length, influence: realCheck.length ? "possible" : "zero (empty note)" },
  partB: {
    samplesPerArm: N,
    ablated_OFF: offT,
    present_ON: onT,
    moduleRecommendationChanged: JSON.stringify(offT.modules) !== JSON.stringify(onT.modules),
    avgConfidenceDelta: onT.avgConfidence != null && offT.avgConfidence != null ? +(onT.avgConfidence - offT.avgConfidence).toFixed(3) : null,
  },
};
process.stdout.write("\n" + JSON.stringify(report, null, 2) + "\n");
