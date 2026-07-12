// Synthetic unit tests for the gate-wall value/ablation analyzer (PART A + scenario A/B logic).
// PART A is pure over receipts; PART B logic is tested with stub gates (no dist import needed).
// Run: node scripts/proving-ground/ablate-gate-wall.test.mjs
import { analyzeGateConstancy, gateScenarios, runScenario, renderAblationReport } from "./ablate-gate-wall.mjs";

const gate = (allow, reason) => ({ operation: "gate.evaluate", metadata: { allow, reason } });
const noise = () => ({ operation: "govexec.run", metadata: {} });

// Corpus 1: constant-allow, mixed cause (the real-world gate-wall shape).
const CONSTANT = [
  gate(true, "gate-wall bypass enabled — allowing all (operator)"),
  gate(true, "gate-wall bypass enabled — allowing all (operator)"),
  gate(true, "tier operator permitted (gateLevel=reduced, autoCommit=true)"),
  noise(), noise(),
];
const a1 = analyzeGateConstancy(CONSTANT);

// Corpus 2: a gate that actually denied sometimes (has realized value).
const MIXED = [
  gate(true, "tier operator permitted"), gate(false, "tier untrusted requires operator approval"),
  gate(true, "tier operator permitted"), gate(false, "git push is not allowed — denying (fail-closed)"),
];
const a2 = analyzeGateConstancy(MIXED);

// PART B with stub gates: ON denies untrusted, OFF (ablated) allows everything.
const gateOnStub = { evaluate: async ({ grant }) => grant.requiresApproval || grant.tier === "untrusted"
  ? { allow: false, reason: "denied" } : { allow: true, reason: "permitted" } };
const gateOffStub = { evaluate: async () => ({ allow: true, reason: "ablated" }) };

const scUntrusted = gateScenarios().find((s) => s.grant.requiresApproval);
const scOperatorBenign = gateScenarios().find((s) => s.name === "operator + benign cmd");

const cases = [
  // ── PART A: constant-allow corpus ────────────────────────────────────────────
  ["evaluations counts only gate.evaluate", () => a1.evaluations === 3],
  ["constant-allow ⇒ constant true", () => a1.constant === true],
  ["constant-allow ⇒ realized value zero", () => a1.realizedValue.startsWith("zero")],
  ["allow-cause attribution: 2 bypass, 1 tier", () => a1.bypassDriven === 2 && a1.tierPermitted === 1],
  ["allowRate 100% when no denies", () => a1.allowRate === 1],

  // ── PART A: mixed corpus has realized value ──────────────────────────────────
  ["mixed corpus: 2 denies counted", () => a2.denies === 2],
  ["mixed corpus: not constant", () => a2.constant === false],
  ["mixed corpus: realized value non-zero", () => a2.realizedValue === "non-zero"],

  // ── PART A: empty corpus is n/a, not a false zero ────────────────────────────
  ["empty corpus ⇒ n/a", () => analyzeGateConstancy([]).realizedValue.startsWith("n/a")],
  ["non-array input tolerated", () => analyzeGateConstancy(null).evaluations === 0],

  // ── PART B: teeth vs no-teeth via ON/OFF diff ────────────────────────────────
  ["untrusted scenario: ON denies, OFF allows ⇒ teeth", async () => {
    const r = await runScenario(scUntrusted, gateOnStub, gateOffStub, {});
    return r.outcomeDiffers === true && r.onAllow === false && r.offAllow === true;
  }],
  ["operator-benign scenario: both allow ⇒ no teeth", async () => {
    const r = await runScenario(scOperatorBenign, gateOnStub, gateOffStub, {});
    return r.outcomeDiffers === false && r.onAllow === true;
  }],

  // ── scenario battery integrity ───────────────────────────────────────────────
  ["battery has both teeth-expected and blind-spot scenarios", () => {
    const s = gateScenarios();
    return s.some((x) => x.expectTeeth) && s.some((x) => !x.expectTeeth);
  }],
  ["a blind-spot scenario targets a dangerous cmd", () => gateScenarios().some((x) => x.action.command === "rm")],

  // ── report renders without throwing and reflects teeth count ─────────────────
  ["renderAblationReport includes verdict + teeth count", async () => {
    const partB = [];
    for (const sc of gateScenarios()) partB.push(await runScenario(sc, gateOnStub, gateOffStub, {}));
    const md = renderAblationReport(a1, partB, "test");
    return md.includes("## Verdict") && md.includes("teeth in") && md.includes("realized value: zero");
  }],
];

let ok = 0;
for (const [name, fn] of cases) {
  let pass = false;
  try { pass = (await fn()) === true; } catch (e) { pass = false; }
  if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${name}`);
}
console.log(`\n${ok}/${cases.length} gate-wall ablation cases pass`);
process.exit(ok === cases.length ? 0 : 1);
