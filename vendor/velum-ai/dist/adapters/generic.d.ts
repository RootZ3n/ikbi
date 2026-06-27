/**
 * Velum — Generic adapter
 * ============================================================
 * Framework-agnostic. Returns a bundle of bound functions configured from a
 * VelumConfig. Use this anywhere — a queue worker, a Lambda, a CLI, a custom
 * server — no framework required.
 * ============================================================
 */
import { type ClassificationResult } from "../core/classify.js";
import { type ScanResult, type ContextScanInput, type ContextScanResult, type OutputGuardResult } from "../core/guard.js";
import { type PiiDetection, type PiiResult, type PiiLevel } from "../core/pii.js";
import { type CredentialMetadata } from "../core/credential-buffer.js";
import { type PatternRegistry } from "../core/patterns.js";
import { type GuardToolCallInput, type GuardToolCallResult } from "../core/tool-guard.js";
import type { VelumConfig } from "../config/schema.js";
export interface Velum {
    config: VelumConfig;
    registry: PatternRegistry;
    enabled: boolean;
    classify(message: string, sessionId?: string): ClassificationResult;
    scanInput(text: string): ScanResult;
    scanContext(messages: ContextScanInput[]): ContextScanResult;
    scanOutput(text: string): ScanResult;
    applyOutputGuard(text: string, opts?: {
        inCharacter: boolean;
    }): OutputGuardResult;
    scanPii(text: string): PiiDetection[];
    maskPii(text: string): {
        text: string;
        placeholderMap: Map<string, string>;
    };
    demask(text: string, placeholderMap: Map<string, string>): string;
    processPii(text: string, level?: PiiLevel): PiiResult;
    /** Consume (single-use) a buffered credential value by id. */
    getCredential(id: string): string | null;
    getAvailableCredentials(pattern?: string): CredentialMetadata[];
    /**
     * Guard a tool call: scan args for injection/secrets, resolve credential
     * placeholders from the buffer, and (when `dispatch` is given) scan the
     * return value. Uses this instance's registry.
     */
    guardToolCall(input: GuardToolCallInput): Promise<GuardToolCallResult>;
}
/**
 * Build a configured Velum instance. Each instance gets its own pattern
 * registry, so custom patterns/neverRedact never leak between instances.
 */
export declare function createVelum(config?: Partial<VelumConfig>): Velum;
//# sourceMappingURL=generic.d.ts.map