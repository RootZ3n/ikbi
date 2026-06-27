/**
 * `velum test <input>` — test a string against all Velum patterns.
 * Shows what would be detected at input, context, output, and PII stages.
 */
import { classify } from "../../core/classify.js";
import { scanInput, scanOutput } from "../../core/guard.js";
import { scanPii } from "../../core/pii.js";
import { registry } from "../../core/patterns.js";
export async function runTest(input, options = {}) {
    const text = input ?? (await readStdin());
    if (!text) {
        process.stderr.write("velum test: no input provided.\n");
        return 2;
    }
    // classify runs without the buffer so `velum test` never stashes a value.
    const classification = classify(text, undefined, { storeInBuffer: false });
    const input_ = scanInput(text);
    const output = scanOutput(text);
    const pii = scanPii(text).map((d) => ({ type: d.type, start: d.start, end: d.end }));
    const report = {
        classification: {
            classification: classification.classification,
            action: classification.action,
            patternsMatched: classification.patternsMatched,
            sanitizedMessage: classification.sanitizedMessage,
        },
        inputGuard: { decision: input_.decision, flags: input_.flags },
        outputGuard: { decision: output.decision, flags: output.flags },
        pii,
    };
    if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return decisionExit(input_.decision, output.decision);
    }
    if (options.explain) {
        return explain(text, classification, input_, output, pii);
    }
    process.stdout.write("\nVelum test\n──────────\n");
    process.stdout.write(`Classification : ${report.classification.classification} (${report.classification.action})\n`);
    if (classification.patternsMatched.length) {
        process.stdout.write(`Patterns       : ${classification.patternsMatched.join(", ")}\n`);
    }
    if (classification.action === "redacted") {
        process.stdout.write(`Sanitized      : ${classification.sanitizedMessage}\n`);
    }
    process.stdout.write(`Input guard    : ${input_.decision}${input_.flags.length ? ` [${input_.flags.join(", ")}]` : ""}\n`);
    process.stdout.write(`Output guard   : ${output.decision}${output.flags.length ? ` [${output.flags.join(", ")}]` : ""}\n`);
    if (pii.length) {
        const counts = {};
        for (const d of pii)
            counts[d.type] = (counts[d.type] ?? 0) + 1;
        process.stdout.write(`PII            : ${Object.entries(counts).map(([t, c]) => `${t}×${c}`).join(", ")}\n`);
    }
    else {
        process.stdout.write("PII            : none\n");
    }
    process.stdout.write("\n");
    return decisionExit(input_.decision, output.decision);
}
/** Human-readable, per-pattern breakdown of why Velum reached its decision. */
function explain(text, cls, input_, output, pii) {
    process.stdout.write("\nVelum — why this decision\n─────────────────────────\n");
    process.stdout.write(`Input          : ${truncate(text)}\n`);
    process.stdout.write(`Classification : ${cls.classification} → action: ${cls.action}\n\n`);
    const fired = new Set([...cls.patternsMatched, ...input_.flags, ...output.flags]);
    if (fired.size === 0 && pii.length === 0) {
        process.stdout.write("No patterns fired — Velum would allow this input unchanged.\n\n");
        return decisionExit(input_.decision, output.decision);
    }
    for (const name of fired) {
        const def = registry.getPattern(name);
        if (!def) {
            process.stdout.write(`• ${name}\n`);
            continue;
        }
        process.stdout.write(`• ${def.name}  [${def.category}/${def.severity}]\n`);
        process.stdout.write(`    ${def.description}\n`);
        process.stdout.write(`    → ${severityMeaning(def.category, def.severity)}\n`);
    }
    if (pii.length) {
        const counts = {};
        for (const d of pii)
            counts[d.type] = (counts[d.type] ?? 0) + 1;
        process.stdout.write(`• PII detected : ${Object.entries(counts).map(([t, c]) => `${t}×${c}`).join(", ")}\n`);
        process.stdout.write("    → Masked/redacted at PII level ≥ 2 before reaching the model.\n");
    }
    process.stdout.write(`\nInput guard    : ${input_.decision}\n`);
    process.stdout.write(`Output guard   : ${output.decision}\n`);
    if (cls.action === "redacted") {
        process.stdout.write(`Sanitized      : ${cls.sanitizedMessage}\n`);
    }
    process.stdout.write("\n");
    return decisionExit(input_.decision, output.decision);
}
function severityMeaning(category, severity) {
    if (category === "credential")
        return "Secret redacted and buffered single-use; the model never sees it.";
    switch (severity) {
        case "block": return "Blocked — the request is refused before it reaches the model.";
        case "review": return "Flagged for review — elevated scrutiny, the operator should see it.";
        case "warn": return "Allowed but recorded — a soft signal worth noting.";
        default: return "Recorded.";
    }
}
function truncate(s, n = 80) {
    return s.length > n ? s.slice(0, n) + "…" : s;
}
function decisionExit(input, output) {
    return input === "block" || output === "block" ? 1 : 0;
}
function readStdin() {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data.trim()));
        process.stdin.on("error", () => resolve(data.trim()));
    });
}
//# sourceMappingURL=test.js.map