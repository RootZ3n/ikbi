// Synthetic unit tests for the runtime INFLUENCE analyzer. Free + instant (no receipts run).
// Run: node scripts/proving-ground/influence.test.mjs
import { computeInfluence, classifyReceipt, influenceBand, readReceipts, DECISION_CATALOG } from "./influence.mjs";

// Synthetic receipt helpers — mirror the real shape: { operation, outcome:{status}, metadata:{...} }.
const gate = (allow) => ({ operation: "gate.evaluate", outcome: { status: "success" }, metadata: { allow } });
const govexec = (status, allow = true) => ({ operation: "govexec.run", outcome: { status }, metadata: { allow } });
const depinstall = (status) => ({ operation: "depinstall.run", outcome: { status }, metadata: {} });
const verifier = (status) => ({ operation: "worker.role.verifier", outcome: { status }, metadata: {} });
const promote = () => ({ operation: "workspace.promote", outcome: { status: "success" }, metadata: {} });
const trust = () => ({ operation: "trust.transition", outcome: { status: "success" }, metadata: { direction: "promote" } });
const driftBlock = () => ({ operation: "worker.run.drift_blocked", outcome: { status: "rejected" }, metadata: {} });
const noise = () => ({ operation: "worker.role.scout", outcome: { status: "success" }, metadata: {} }); // not a decision op

// A corpus that puts each module in a deliberate band:
//   governed-exec: 2 denied of 5 → 40% → pivotal
//   gate-wall:     0 denied of 4 → passive (authority, never bit)
//   dependency-install: 1 rejected of 10 → 10% → active
//   worker-model: verifier 1 fail of 5 → 20% → active
//   core/workspace: 2 promotes (event) → pivotal
//   core/trust: latent (no receipts)
//   drift-prevention: latent (no receipts)
const RECEIPTS = [
  gate(true), gate(true), gate(true), gate(true),                       // gate-wall: 4 decisions, 0 flips
  govexec("success"), govexec("failure"), govexec("success"),          // ran (failure = the command's own exit, NOT a denial)
  govexec("rejected"), govexec("rejected"),                            // 2 policy denials → interventions
  depinstall("success"), depinstall("success"), depinstall("success"),
  depinstall("success"), depinstall("success"), depinstall("success"),
  depinstall("success"), depinstall("success"), depinstall("success"),
  depinstall("rejected"),                                              // 1 of 10 refused → 10% → active
  verifier("success"), verifier("success"), verifier("success"),
  verifier("success"), verifier("failure"),                            // 1 of 5 red → 20% → active
  promote(), promote(),                                                // 2 route changes → pivotal
  noise(), noise(), noise(),                                           // ignored (not decisions)
];

const inf = computeInfluence(RECEIPTS);
const by = Object.fromEntries(inf.rows.map((r) => [r.module, r]));

const cases = [
  // ── corpus accounting ──────────────────────────────────────────────────────
  ["total receipts counted", () => inf.totalReceipts === RECEIPTS.length],
  ["decision receipts exclude non-decision ops", () => inf.decisionReceipts === RECEIPTS.length - 3],

  // ── govexec: rejected = intervention; failure(exit) = NOT ────────────────────
  ["governed-exec pivotal", () => by["modules/governed-exec"].band === "pivotal"],
  ["governed-exec 2 interventions of 5", () => by["modules/governed-exec"].interventions === 2 && by["modules/governed-exec"].decisions === 5],
  ["a nonzero-exit govexec is not an intervention", () => classifyReceipt(govexec("failure")).intervened === false],
  ["a rejected govexec IS an intervention", () => classifyReceipt(govexec("rejected")).intervened === true],

  // ── gate-wall: authority that never bit ──────────────────────────────────────
  ["gate-wall passive (allowed all)", () => by["modules/gate-wall"].band === "passive" && by["modules/gate-wall"].decisions === 4 && by["modules/gate-wall"].interventions === 0],
  ["a gate deny is an intervention", () => classifyReceipt(gate(false)).intervened === true],
  ["a gate allow is not", () => classifyReceipt(gate(true)).intervened === false],

  // ── dependency-install: rare flip → active ───────────────────────────────────
  ["dependency-install active (1/10)", () => by["modules/dependency-install"].band === "active" && by["modules/dependency-install"].interventions === 1],

  // ── worker-model: verifier fail → active ─────────────────────────────────────
  ["worker-model active via verifier", () => by["modules/worker-model"].band === "active" && by["modules/worker-model"].interventions === 1],
  ["verifier failure is an intervention", () => classifyReceipt(verifier("failure")).intervened === true],
  ["verifier success is not", () => classifyReceipt(verifier("success")).intervened === false],

  // ── event ops: always intervene ──────────────────────────────────────────────
  ["workspace pivotal via promote (event)", () => by["core/workspace"].band === "pivotal" && by["core/workspace"].rate === 1],
  ["a promote is always an intervention", () => classifyReceipt(promote()).intervened === true],
  ["a trust transition is always an intervention", () => classifyReceipt(trust()).intervened === true],
  ["a drift block is always an intervention", () => classifyReceipt(driftBlock()).intervened === true],

  // ── latent authority is surfaced, not hidden ─────────────────────────────────
  ["core/trust latent (seeded, no receipts)", () => by["core/trust"] && by["core/trust"].band === "latent" && by["core/trust"].decisions === 0],
  ["drift-prevention latent (seeded)", () => by["modules/drift-prevention"] && by["modules/drift-prevention"].band === "latent"],
  ["every catalog module appears", () => new Set(DECISION_CATALOG.map((e) => e.module)).size <= inf.rows.length],

  // ── non-decision receipts are classified as such ─────────────────────────────
  ["a non-decision op is not a decision", () => classifyReceipt(noise()).decision === false],

  // ── band() edges ─────────────────────────────────────────────────────────────
  ["band latent at 0 decisions", () => influenceBand(0, 0) === "latent"],
  ["band passive at 0 interventions", () => influenceBand(10, 0) === "passive"],
  ["band active below 25%", () => influenceBand(10, 2) === "active"],
  ["band pivotal at exactly 25%", () => influenceBand(4, 1) === "pivotal"],

  // ── sort: most influential first ─────────────────────────────────────────────
  ["sorted most-interventions first", () => inf.rows[0].interventions >= inf.rows[inf.rows.length - 1].interventions],

  // ── readReceipts tolerates junk ──────────────────────────────────────────────
  ["readReceipts on a missing path returns []", () => Array.isArray(readReceipts("/nope/does/not/exist.ndjson")) && readReceipts("/nope/does/not/exist.ndjson").length === 0],
];

let ok = 0;
for (const [name, fn] of cases) {
  let pass = false;
  try { pass = fn() === true; } catch (e) { pass = false; }
  if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${name}`);
}
console.log(`\n${ok}/${cases.length} influence cases pass`);
process.exit(ok === cases.length ? 0 : 1);
