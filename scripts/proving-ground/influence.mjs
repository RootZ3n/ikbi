// @ts-nocheck
/**
 * ikbi runtime INFLUENCE analyzer — the THIRD dimension of runtime truth.
 *
 * Reachability answers "was it executed?"; FREQUENCY answers "how often / how broadly?" — both
 * measure PRESENCE. INFLUENCE asks the harder question: *did a module's output change a DECISION?*
 * A module can run in every surface (ubiquitous) and still steer nothing — it rubber-stamps the
 * happy path. Another can run once and flip a promote to a discard. Presence ≠ power.
 *
 * The signal is the RECEIPT STREAM, not coverage. Reachability parses receipts only to COUNT ops
 * (`ops[op]++`) and throws the outcome away; influence keeps the outcome. Every decision receipt
 * carries a branch: a gate `allow:true|false`, a govexec `rejected` (denied) vs ran, a promote
 * (a route/state change), a trust `transition` (a tier flip that re-gates every future run), a
 * verifier `failure` (a red check that blocks promotion). We attribute each decision to its owning
 * module and measure how often that module's output took the flow OFF the default path.
 *
 *   decisions      — decision-bearing receipts attributed to the module
 *   interventions  — of those, how many FLIPPED the flow (deny / reject / discard / demote / block)
 *   rate           — interventions / decisions (how sharply the module steers when it speaks)
 *   band           — pivotal | active | passive | latent (see `influenceBand`)
 *
 * A `passive` module holds decision authority but never exercised it in this corpus (e.g. a gate
 * that evaluated 700 times and denied 0 — real authority, untested steering). A `latent` module is
 * in the decision catalog but emitted no decision receipts at all. Both are ablation entry points:
 * "authority that never bit" is exactly where value(dimension 4) should probe next.
 *
 * PURE over an array of parsed receipts (no re-run, no coverage) — unit-tested with synthetic
 * receipts. The CLI reads a `receipts.ndjson` and writes INFLUENCE-REPORT.md.
 *
 * The dimensions of runtime truth, in order of depth:
 *   1. reachability (cov-analyze/reach-report) — was it executed?          [DONE]
 *   2. frequency (frequency.mjs)               — how often / how broadly?  [DONE]
 *   3. INFLUENCE (this file)                    — did it change a decision? [DONE]
 *   4. value / ablation (ablate-drift)          — would the outcome change? [DONE for drift]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The DECISION CATALOG — the receipt operations that represent a genuine gate / branch / route
 * decision, each mapped to its owning module (using the same `modules/<X>` / `core/<X>` keys as
 * reachability + frequency, so all three dimensions line up) and a classifier that returns TRUE
 * when the receipt's outcome is an INTERVENTION (flow taken off the default/happy path).
 *
 *   kind "conditional" — the op fires on EVERY check; only some fire an intervention. Report a RATE.
 *   kind "event"       — the op fires ONLY when the module steers; every one IS an intervention.
 *
 * Grounded in the real receipt shape: `outcome.status` ∈ {success,failure,rejected} and op-specific
 * `metadata` fields (gate `allow`, trust `direction`, …). Ops not listed here are execution, not
 * decision — reachability/frequency already cover their presence.
 */
export const DECISION_CATALOG = [
  { op: "gate.evaluate", module: "modules/gate-wall", kind: "conditional",
    intervened: (r) => r?.metadata?.allow === false,
    why: "gate-wall DENIED an action (allow:false) instead of permitting it" },
  { op: "govexec.run", module: "modules/governed-exec", kind: "conditional",
    intervened: (r) => r?.outcome?.status === "rejected" || r?.metadata?.allow === false,
    why: "governed-exec REFUSED to run a command (policy/sandbox denial), not merely a nonzero exit" },
  { op: "depinstall.run", module: "modules/dependency-install", kind: "conditional",
    intervened: (r) => r?.outcome?.status === "rejected",
    why: "dependency-install REFUSED an install (missing lockfile / scripts / no sandbox)" },
  { op: "worker.role.verifier", module: "modules/worker-model", kind: "conditional",
    intervened: (r) => r?.outcome?.status === "failure",
    why: "the verifier FAILED the build (a red check that blocks promotion)" },
  { op: "workspace.promote", module: "core/workspace", kind: "event",
    intervened: () => true,
    why: "a promote mutated the target repo — a route/state change" },
  { op: "trust.transition", module: "core/trust", kind: "event",
    intervened: () => true,
    why: "a trust tier changed — re-gates every future run (promote or demote both steer)" },
  { op: "worker.trust.signal_suppressed", module: "modules/worker-model", kind: "event",
    intervened: () => true,
    why: "a trust signal was suppressed — altered the trust-accounting branch" },
  { op: "worker.run.drift_blocked", module: "modules/drift-prevention", kind: "event",
    intervened: () => true,
    why: "drift-prevention BLOCKED a build at zero API cost — a degraded-agent circuit breaker" },
];

/** Look up a receipt's catalog entry by exact operation name (undefined ⇒ not a decision op). */
export function catalogEntry(operation, catalog = DECISION_CATALOG) {
  return catalog.find((e) => e.op === operation);
}

/** Classify ONE receipt: is it a decision, and if so did it intervene, and who owns it. PURE. */
export function classifyReceipt(receipt, catalog = DECISION_CATALOG) {
  const entry = catalogEntry(receipt?.operation, catalog);
  if (!entry) return { decision: false };
  return { decision: true, module: entry.module, op: entry.op, kind: entry.kind, intervened: entry.intervened(receipt) === true };
}

/**
 * The influence band for a module from its decision/intervention tallies:
 *   pivotal — steered materially: flipped ≥ 1 decision AND does so ≥ 25% of the time it decides
 *             (event ops are always 100% ⇒ always pivotal when they fired)
 *   active  — flipped ≥ 1 decision, but rarely (< 25% — it CAN steer and occasionally does)
 *   passive — held decision authority (≥ 1 decision receipt) but flipped NOTHING (only rubber-stamped)
 *   latent  — in the decision catalog but emitted no decision receipts in this corpus
 */
export function influenceBand(decisions, interventions) {
  if (decisions <= 0) return "latent";
  if (interventions <= 0) return "passive";
  return interventions / decisions >= 0.25 ? "pivotal" : "active";
}

/**
 * Compute the influence dimension from an array of parsed receipts. PURE — no I/O. Every module in
 * the catalog appears (even at 0 decisions, as `latent`) so "authority that never fired" is visible,
 * not silently absent.
 */
export function computeInfluence(receipts, catalog = DECISION_CATALOG) {
  const list = Array.isArray(receipts) ? receipts : [];
  // seed every catalog module so latent authority is never hidden
  const agg = new Map();
  const seed = (module) => {
    if (!agg.has(module)) agg.set(module, { module, decisions: 0, interventions: 0, ops: new Map() });
    return agg.get(module);
  };
  for (const e of catalog) seed(e.module);

  let decisionReceipts = 0;
  for (const r of list) {
    const c = classifyReceipt(r, catalog);
    if (!c.decision) continue;
    decisionReceipts++;
    const m = seed(c.module);
    m.decisions++;
    if (c.intervened) m.interventions++;
    const o = m.ops.get(c.op) ?? { op: c.op, kind: c.kind, decisions: 0, interventions: 0 };
    o.decisions++;
    if (c.intervened) o.interventions++;
    m.ops.set(c.op, o);
  }

  const rows = [...agg.values()].map((m) => ({
    module: m.module,
    decisions: m.decisions,
    interventions: m.interventions,
    rate: m.decisions > 0 ? m.interventions / m.decisions : 0,
    band: influenceBand(m.decisions, m.interventions),
    ops: [...m.ops.values()].sort((a, b) => b.interventions - a.interventions || b.decisions - a.decisions || a.op.localeCompare(b.op)),
  }));
  // Most influential first: interventions, then how sharply it steers, then breadth of decisions.
  rows.sort((a, b) => b.interventions - a.interventions || b.rate - a.rate || b.decisions - a.decisions || a.module.localeCompare(b.module));
  return { totalReceipts: list.length, decisionReceipts, rows };
}

/** Parse a receipts.ndjson into an array of receipt objects (skips blank/corrupt lines). */
export function readReceipts(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Render the influence report as markdown. */
export function renderInfluenceReport(inf, source) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const counts = {};
  for (const r of inf.rows) counts[r.band] = (counts[r.band] || 0) + 1;
  let md = "# ikbi Runtime INFLUENCE Report\n\n";
  md += "The third dimension of runtime truth (after reachability + frequency): not just *whether* or\n";
  md += "*how often* a module ran, but whether its output actually **changed a decision** — flipped a\n";
  md += "gate, blocked a promote, refused a command, moved a trust tier. Presence ≠ power. Read from the\n";
  md += "decision-bearing receipt stream (the outcome reachability discards), not coverage.\n\n";
  md += `Receipts analyzed: ${inf.totalReceipts} (${inf.decisionReceipts} decision-bearing)`;
  if (source) md += `  ·  source: ${source}`;
  md += "\n\n## Bands\n\n";
  md += "- **pivotal** — flipped ≥1 decision and steers sharply (≥25% of its decisions, or an event gate)\n";
  md += "- **active** — flipped ≥1 decision, but only occasionally (<25%)\n";
  md += "- **passive** — held decision authority but flipped NOTHING here (rubber-stamped the happy path)\n";
  md += "- **latent** — a decision module that emitted no decision receipts this corpus\n\n";
  for (const b of ["pivotal", "active", "passive", "latent"]) md += `- ${b}: ${counts[b] || 0}\n`;
  md += "\n## Per-module influence\n\n";
  md += "| module | band | decisions | interventions | rate | decision ops (intervened/total) |\n";
  md += "| --- | --- | --- | --- | --- | --- |\n";
  for (const r of inf.rows) {
    const opsCell = r.ops.map((o) => `${o.op} ${o.interventions}/${o.decisions}`).join("; ") || "—";
    md += `| ${r.module} | ${r.band} | ${r.decisions} | ${r.interventions} | ${pct(r.rate)} | ${opsCell} |\n`;
  }
  md += "\n> **passive / latent** authority is the entry point for dimension 4 (value/ablation): a gate\n";
  md += "> that never bit in this corpus is where you ask \"would the outcome change if it didn't exist?\"\n";
  return md;
}

// CLI: read a receipts.ndjson, compute influence, write INFLUENCE-REPORT.md.
// Usage: node scripts/proving-ground/influence.mjs [path/to/receipts.ndjson]
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
  const receipts = readReceipts(source);
  const inf = computeInfluence(receipts);
  const md = renderInfluenceReport(inf, source.replace(IKBI + "/", ""));
  const repoMd = join(IKBI, "scripts", "proving-ground", "INFLUENCE-REPORT.md");
  writeFileSync(repoMd, md);
  console.log(md);
  console.log(`\nwrote ${repoMd}`);
}
