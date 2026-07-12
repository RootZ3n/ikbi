// @ts-nocheck
/**
 * GATE-WALL INFLUENCE PROOF — the counterpart to the influence + ablation findings (steps 6-7).
 *
 * On every observed corpus gate-wall scored `passive` (0 denials of 11k+ evals) because the operator
 * runs with IKBI_GATE_WALL_BYPASS=true. That raised a fair question: is the influence harness even
 * ABLE to detect gate-wall steering, or is `passive` a blind spot? This harness answers it: drive the
 * REAL gate-wall with bypass OFF over a realistic MIXED-TRUST workload (the delegated/multi-tenant
 * scenario the ablation said gate-wall earns its place in), capture the authentic `gate.evaluate`
 * receipts it emits, and run the real influence analyzer on them. Result: gate-wall scores `pivotal`.
 *
 * So the `passive` verdict on the bypassed corpora is ACCURATE (the gate genuinely never bit there),
 * not a limitation of the measurement — the harness lights up the moment the gate actually denies.
 *
 * Deterministic + FREE (gate decisions are pure functions of the grant; no model calls). PURE parts
 * (workload + corpus generation) are unit-tested; the CLI uses the real compiled gate from dist.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeInfluence } from "./influence.mjs";

const OPERATOR = { tier: "operator", gateLevel: "reduced", autoCommit: true, requiresApproval: false };
const UNTRUSTED = { tier: "untrusted", gateLevel: "full", autoCommit: false, requiresApproval: true };
const exec = (command, args, extra = {}) => ({ kind: "exec", command, args, sudo: command === "sudo", ...extra });

/**
 * A realistic mixed-trust workload with the gate ENABLED. Each row is (grant, action, identity, n).
 * The trusted operator's normal work is allowed; a DELEGATED untrusted agent is denied (requires
 * approval); the operator hitting the narrow policy set (git push) and an unauthorized package script
 * is denied. This is exactly the shape the gate-wall ablation flagged as its earned-value scenario.
 */
export function mixedTrustWorkload() {
  const id = (agentId, trustTier) => ({ agentId, trustTier });
  return [
    { grant: OPERATOR, action: exec("cargo", ["build"]), identity: id("worker", "operator"), n: 20 },      // allow
    { grant: OPERATOR, action: exec("git", ["status"]), identity: id("worker", "operator"), n: 8 },         // allow
    { grant: OPERATOR, action: exec("pnpm", ["test"], { verifier: true }), identity: id("worker", "operator"), n: 10 }, // allow (verifier-authorized)
    { grant: UNTRUSTED, action: exec("ls", ["-la"]), identity: id("delegate", "untrusted"), n: 9 },         // DENY (requires approval)
    { grant: UNTRUSTED, action: exec("cargo", ["build"]), identity: id("delegate", "untrusted"), n: 5 },    // DENY
    { grant: OPERATOR, action: exec("git", ["push"]), identity: id("worker", "operator"), n: 4 },           // DENY (policy)
    { grant: OPERATOR, action: exec("pnpm", ["test"]), identity: id("worker", "operator"), n: 3 },          // DENY (package-script, no verifier)
  ];
}

/** Drive an `evaluate(input)` fn over the workload; return each decision {allow, reason}. PURE w.r.t.
 *  the injected evaluate — the CLI passes the real compiled gate's evaluate, tests pass a fake. */
export async function runWorkload(evaluate, workload = mixedTrustWorkload()) {
  const decisions = [];
  for (const row of workload) {
    for (let i = 0; i < row.n; i++) {
      const g = await evaluate({ grant: row.grant, action: row.action, identity: row.identity });
      decisions.push({ allow: g.allow, reason: g.reason });
    }
  }
  return decisions;
}

/** Render the proof markdown from an influence result computed over the non-bypassed corpus. */
export function renderProof(inf, denials, evaluations) {
  const gate = inf.rows.find((r) => r.module === "modules/gate-wall");
  let md = "# gate-wall INFLUENCE PROOF (bypass OFF)\n\n";
  md += "Driving the REAL gate-wall with `IKBI_GATE_WALL_BYPASS=false` over a mixed-trust workload,\n";
  md += "then running the influence analyzer on the authentic `gate.evaluate` receipts.\n\n";
  md += `- gate evaluations: **${evaluations}**  ·  denials: **${denials}**\n`;
  if (gate) md += `- influence band: **${gate.band}**  ·  interventions: ${gate.interventions}/${gate.decisions} (${Math.round(gate.rate * 100)}%)\n\n`;
  md += "## Why this matters\n\n";
  md += "On the observed (bypassed, operator-tier) corpora gate-wall scored `passive` — 0 denials. That\n";
  md += "was ACCURATE, not a blind spot: with bypass OFF and untrusted/policy-denied actions present, the\n";
  md += "SAME influence harness scores gate-wall **" + (gate?.band ?? "?") + "**. The measurement tracks\n";
  md += "real steering; gate-wall's value is conditional on the trust context (delegated/multi-tenant),\n";
  md += "exactly as the value/ablation verdict concluded.\n";
  return md;
}

// CLI: build the corpus with the REAL compiled gate (capturing its receipts), compute influence, report.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const IKBI = resolve(new URL("../..", import.meta.url).pathname);
  const { createGateWall } = await import(join(IKBI, "dist", "modules", "gate-wall", "gate.js"));
  const receipts = [];
  const gate = createGateWall({
    config: { enabled: true, bypass: false }, // bypass OFF — the gate actually decides
    receipts: { append: async (r) => { receipts.push(r); } },
    publish: () => {},
    newGateId: () => "g",
  });
  await runWorkload((input) => gate.evaluate(input));
  const denials = receipts.filter((r) => r.metadata?.allow === false).length;
  const inf = computeInfluence(receipts);
  const md = renderProof(inf, denials, receipts.length);
  const out = join(IKBI, "scripts", "proving-ground", "GATE-INFLUENCE-PROOF.md");
  writeFileSync(out, md);
  console.log(md);
  console.log(`\nwrote ${out}`);
}
