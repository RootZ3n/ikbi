/**
 * `velum audit tail <path>`    — show the most recent audit receipts.
 * `velum audit summary <path>` — redaction rates + top-firing patterns.
 *
 * Reads the JSONL audit log emitted when `auditLogPath` is configured.
 */
export interface AuditOptions {
    json?: boolean;
    /** Number of lines for `tail` (default 20). */
    limit?: number;
}
export declare function runAudit(sub: string | undefined, path: string | undefined, options?: AuditOptions): Promise<number>;
//# sourceMappingURL=audit.d.ts.map