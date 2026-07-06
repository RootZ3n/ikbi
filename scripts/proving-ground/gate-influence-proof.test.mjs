// Unit tests for the gate-wall influence proof. The workload logic is pure; the gate decisions come
// from the REAL compiled gate (dist) so the proof rests on production code, not a reimplementation.
// Run: node scripts/proving-ground/gate-influence-proof.test.mjs
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mixedTrustWorkload, runWorkload, renderProof } from "./gate-influence-proof.mjs";
import { computeInfluence } from "./influence.mjs";

const IKBI = resolve(new URL("../..", import.meta.url).pathname);
const { createGateWall } = await import(join(IKBI, "dist", "modules", "gate-wall", "gate.js"));

// Real gate, bypass OFF, capturing its authentic receipts.
const receipts = [];
const gate = createGateWall({
  config: { enabled: true, bypass: false },
  receipts: { append: async (r) => { receipts.push(r); } },
  publish: () => {},
  newGateId: () => "g",
});
const decisions = await runWorkload((input) => gate.evaluate(input));
const inf = computeInfluence(receipts);
const gw = inf.rows.find((r) => r.module === "modules/gate-wall");
const denials = decisions.filter((d) => !d.allow).length;

const cases = [
  ["workload produces the expected N decisions", () => decisions.length === mixedTrustWorkload().reduce((a, r) => a + r.n, 0)],
  ["the real gate DENIES untrusted + policy actions (bypass off)", () => denials === 9 + 5 + 4 + 3],
  ["the real gate ALLOWS operator + verifier-authorized actions", () => decisions.filter((d) => d.allow).length === 20 + 8 + 10],
  ["every decision surfaced as an authentic gate.evaluate receipt", () => receipts.length === decisions.length && receipts.every((r) => r.operation === "gate.evaluate")],
  ["influence scores gate-wall PIVOTAL on the non-bypassed corpus", () => gw && gw.band === "pivotal"],
  ["gate-wall interventions == the denial count", () => gw && gw.interventions === denials],
  ["a denial reason names the untrusted-approval or policy cause", () => decisions.some((d) => !d.allow && /approval|not allowed|verifier/i.test(d.reason ?? ""))],
  ["renderProof reports the pivotal band + denial count", () => { const md = renderProof(inf, denials, receipts.length); return md.includes("pivotal") && md.includes(String(denials)); }],
];

let ok = 0;
for (const [name, fn] of cases) {
  let pass = false;
  try { pass = fn() === true; } catch (e) { pass = false; }
  if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${name}`);
}
console.log(`\n${ok}/${cases.length} gate-influence-proof cases pass`);
process.exit(ok === cases.length ? 0 : 1);
