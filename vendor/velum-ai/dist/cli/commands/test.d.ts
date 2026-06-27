/**
 * `velum test <input>` — test a string against all Velum patterns.
 * Shows what would be detected at input, context, output, and PII stages.
 */
export interface TestOptions {
    json?: boolean;
    /** Print which pattern fired, its severity, and why — in plain English. */
    explain?: boolean;
}
export declare function runTest(input: string | undefined, options?: TestOptions): Promise<number>;
//# sourceMappingURL=test.d.ts.map