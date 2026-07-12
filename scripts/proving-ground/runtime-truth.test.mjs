// Unit tests for the runtime-truth roll-up (composition of influence + gate-wall value). Pure.
// Run: node scripts/proving-ground/runtime-truth.test.mjs
import { computeRuntimeTruth, renderRuntimeTruth } from "./runtime-truth.mjs";

const gate = (allow, reason) => ({ operation: "gate.evaluate", metadata: { allow, reason }, outcome: { status: "success" } });
const govexecRej = () => ({ operation: "govexec.run", outcome: { status: "rejected" }, metadata: { allow: true } });
const govexecOk = () => ({ operation: "govexec.run", outcome: { status: "success" }, metadata: { allow: true } });
const promote = () => ({ operation: "workspace.promote", outcome: { status: "success" }, metadata: {} });

// A synthetic build corpus: gate always allowed (bypass), govexec denied twice, one promote.
const RECEIPTS = [
  gate(true, "gate-wall bypass enabled — allowing all (operator)"),
  gate(true, "gate-wall bypass enabled — allowing all (operator)"),
  govexecOk(), govexecOk(), govexecRej(), govexecRej(),
  promote(),
];
// Injected gate ablation PART B (so the test stays pure — no dist import).
const GATE_AB = [
  { name: "untrusted + benign", onAllow: false, offAllow: true, outcomeDiffers: true },
  { name: "operator + git push", onAllow: false, offAllow: true, outcomeDiffers: true },
  { name: "operator + benign", onAllow: true, offAllow: true, outcomeDiffers: false },
];

const rt = computeRuntimeTruth(RECEIPTS, GATE_AB);
const md = renderRuntimeTruth(rt, "synthetic");
const infBy = Object.fromEntries(rt.influence.rows.map((r) => [r.module, r]));

const cases = [
  ["totalReceipts counted", () => rt.totalReceipts === RECEIPTS.length],
  ["decisionReceipts excludes nothing here (all 7 are decisions)", () => rt.decisionReceipts === 7],
  ["influence composed: governed-exec pivotal (2/4)", () => infBy["modules/governed-exec"].band === "pivotal" && infBy["modules/governed-exec"].interventions === 2],
  ["influence composed: gate-wall passive (0 of 2)", () => infBy["modules/gate-wall"].band === "passive"],
  ["influence composed: workspace pivotal via promote", () => infBy["core/workspace"].band === "pivotal"],
  ["gate constancy: 2 evals, 0 denies, both bypass", () => rt.gateConstancy.evaluations === 2 && rt.gateConstancy.denies === 0 && rt.gateConstancy.bypassDriven === 2],
  ["gate realized value zero", () => rt.gateConstancy.realizedValue.startsWith("zero")],
  ["gate ablation passed through", () => rt.gateAblation.length === 3],
  ["render includes all three sections", () => md.includes("## Decision modules") && md.includes("## Value probe") && md.includes("## One-line verdict")],
  ["render teeth count reflects injected ablation", () => md.includes("**2/3**")],
  ["verdict names governed-exec pivotal + gate-wall passive", () => /Pivotal[^.]*governed-exec/.test(md) && /Passive[^.]*gate-wall/.test(md)],
  ["null gateAblation tolerated", () => { const r = computeRuntimeTruth(RECEIPTS, null); return r.gateAblation === null && renderRuntimeTruth(r, "x").includes("realized value"); }],
  ["empty corpus tolerated", () => { const r = computeRuntimeTruth([], null); return r.totalReceipts === 0 && r.decisionReceipts === 0; }],
];

let ok = 0;
for (const [name, fn] of cases) {
  let pass = false;
  try { pass = fn() === true; } catch (e) { pass = false; }
  if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${name}`);
}
console.log(`\n${ok}/${cases.length} runtime-truth cases pass`);
process.exit(ok === cases.length ? 0 : 1);
