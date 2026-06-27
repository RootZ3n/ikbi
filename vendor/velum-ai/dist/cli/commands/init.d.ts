/**
 * `velum init` — generate a velum.config.yaml with documented defaults.
 */
export declare const CONFIG_TEMPLATE = "# Velum configuration\n# AI Privacy & Injection Defense \u2014 https://www.npmjs.com/package/velum-ai\n\n# Master switch. When false, Velum passes everything through untouched.\nenabled: true\n\n# Default PII handling level for modules without an override:\n#   1 = Observe  (detect + log only, text unchanged)\n#   2 = Redact   (replace PII with reversible typed placeholders, e.g. [EMAIL_1])\n#   3 = Sanitize (strip PII to [REDACTED], not reversible)\ndefaultPiiLevel: 1\n\n# Credential buffer time-to-live, in milliseconds (default 5 minutes).\ncredentialBufferTtlMs: 300000\n\n# Extra terms that must never be redacted as credentials (case-insensitive).\n# Your product/tool names go here to avoid false positives.\nneverRedact:\n  - myproduct\n  - myservice\n\n# Optional JSONL audit log + receipts directory.\n# auditLogPath: ./state/velum-audit.jsonl\n# receiptsDir: ./state/receipts\n\n# Per-module PII level overrides, keyed by module/route name.\nmodules:\n  chat:\n    piiLevel: 2\n  internal:\n    piiLevel: 1\n";
export interface InitOptions {
    cwd?: string;
    force?: boolean;
    path?: string;
    /** Product preset name (nusika, toba, looney-luna). */
    preset?: string;
}
export declare function runInit(options?: InitOptions): Promise<number>;
//# sourceMappingURL=init.d.ts.map