/**
 * Velum — Audit Receipts
 * ============================================================
 * Turns Velum from a silent filter into an observable one. Each guard decision
 * can emit a single JSONL line to an append-only audit log:
 *
 *   { ts, stage, decision, patterns: [...names], counts: {...}, sessionId? }
 *
 * The receipt records WHAT fired (pattern *names*, category counts) and the
 * decision — NEVER the raw values being redacted. This preserves Velum's
 * redaction guarantee: a leaked audit log can reveal that an OpenAI key was
 * seen, but never the key itself.
 *
 * Emission is opt-in: nothing is written until `configureReceipts({ auditLogPath })`
 * is called (the config loader / createVelum wire this from `auditLogPath`).
 * Stays within the zero-dependency guarantee (node:fs only).
 * ============================================================
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
let auditLogPath;
let dirEnsured = false;
/** Enable/disable receipt emission and set the audit log path. */
export function configureReceipts(opts) {
    auditLogPath = opts.auditLogPath;
    dirEnsured = false;
}
export function getReceiptConfig() {
    return { auditLogPath };
}
/**
 * Append one receipt line to the audit log. No-op when no path is configured.
 * Never throws — observability must never break the guard path.
 */
export function emitReceipt(entry) {
    if (!auditLogPath)
        return;
    try {
        if (!dirEnsured) {
            mkdirSync(dirname(auditLogPath), { recursive: true });
            dirEnsured = true;
        }
        const receipt = { ts: entry.ts ?? new Date().toISOString(), ...stripValues(entry) };
        appendFileSync(auditLogPath, JSON.stringify(receipt) + "\n", "utf-8");
    }
    catch {
        /* swallow — auditing is best-effort */
    }
}
/** Defensive: keep only the allow-listed, value-free fields. */
function stripValues(entry) {
    return {
        stage: entry.stage,
        decision: entry.decision,
        ...(entry.patterns && entry.patterns.length ? { patterns: entry.patterns } : {}),
        ...(entry.counts && Object.keys(entry.counts).length ? { counts: entry.counts } : {}),
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
    };
}
//# sourceMappingURL=receipts.js.map