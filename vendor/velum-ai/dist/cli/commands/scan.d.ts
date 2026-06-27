/**
 * `velum scan <path>` — scan files (or stdin) for credentials, injection, and PII.
 */
export interface ScanFinding {
    file: string;
    line: number;
    category: string;
    pattern: string;
    severity: string;
    preview: string;
}
export interface ScanOptions {
    json?: boolean;
    cwd?: string;
}
export declare function runScan(target: string | undefined, options?: ScanOptions): Promise<number>;
//# sourceMappingURL=scan.d.ts.map