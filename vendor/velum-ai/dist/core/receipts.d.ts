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
export type ReceiptStage = "input" | "context" | "output" | "request" | "response" | "tool";
export interface Receipt {
    /** ISO timestamp. */
    ts: string;
    stage: ReceiptStage;
    /** Guard decision (allow/warn/review/block) or classification label. */
    decision: string;
    /** Names of the patterns that fired (never the matched values). */
    patterns?: string[];
    /** Aggregate counts, e.g. { redacted: 2, pii: 1 }. */
    counts?: Record<string, number>;
    /** Caller-supplied session id (opaque). */
    sessionId?: string;
    /** Tool name for stage === "tool". */
    toolName?: string;
}
/** Enable/disable receipt emission and set the audit log path. */
export declare function configureReceipts(opts: {
    auditLogPath?: string;
}): void;
export declare function getReceiptConfig(): {
    auditLogPath?: string;
};
/**
 * Append one receipt line to the audit log. No-op when no path is configured.
 * Never throws — observability must never break the guard path.
 */
export declare function emitReceipt(entry: Omit<Receipt, "ts"> & {
    ts?: string;
}): void;
//# sourceMappingURL=receipts.d.ts.map