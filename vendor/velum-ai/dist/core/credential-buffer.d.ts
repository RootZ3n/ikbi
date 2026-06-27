/**
 * Velum — Credential Buffer
 * ============================================================
 * In-memory, short-lived, single-use vault for credentials extracted from
 * user input. When Velum redacts a secret from the model's view, the raw
 * value lands here so a downstream tool can consume it WITHOUT the model
 * ever seeing it.
 *
 * Guarantees:
 *  - Values expire after a TTL (default 5 minutes)
 *  - Values are single-use: consuming one marks it spent
 *  - Values are NEVER logged, NEVER written to disk, NEVER in API responses
 *    (only metadata — pattern/context/age — is ever exposed)
 * ============================================================
 */
export interface CredentialEntry {
    id: string;
    pattern: string;
    value: string;
    context: string;
    createdAt: number;
    ttlMs: number;
    consumed: boolean;
}
/** Safe-to-expose view of a buffered credential — never includes the value. */
export interface CredentialMetadata {
    id: string;
    pattern: string;
    context: string;
    createdAt: number;
    ttlMs: number;
    consumed: boolean;
    ageMs: number;
    expired: boolean;
}
export declare const DEFAULT_TTL_MS: number;
/** Override the default TTL for newly stored credentials (mainly for config/tests). */
export declare function setCredentialTtl(ms: number): void;
export declare function getCredentialTtl(): number;
/** Store a credential and return its opaque buffer id. */
export declare function storeCredential(pattern: string, value: string, context: string): string;
/**
 * Fetch a live (unconsumed, unexpired) entry, or null. Expired entries are evicted.
 *
 * @internal Exposes the raw credential value — NOT part of the public API.
 *   Use {@link consumeCredential} (single-use) or {@link getAvailableCredentials}
 *   (metadata only) instead.
 */
export declare function getCredential(id: string): CredentialEntry | null;
/** Consume a credential exactly once, returning its raw value (or null). */
export declare function consumeCredential(id: string): string | null;
/** List metadata for available credentials (never the values). */
export declare function getAvailableCredentials(pattern?: string): CredentialMetadata[];
/** Evict all consumed or expired entries. */
export declare function clearExpiredCredentials(): void;
/** Drop every entry. Primarily for tests. */
export declare function clearAllCredentials(): void;
//# sourceMappingURL=credential-buffer.d.ts.map