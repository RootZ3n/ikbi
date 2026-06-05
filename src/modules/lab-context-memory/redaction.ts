/**
 * ikbi lab-context-memory — SECRET SCRUB for durable cross-agent memory (H7).
 *
 * `record()` persists `value` into a DURABLE store with no TTL — it outlives the
 * ≤30-day receipts. So a secret written verbatim would live indefinitely, exposed to
 * any reader / debug dump / future feature regardless of read-time neutralization
 * (which mitigates injection, NOT secrets-at-rest). This module scrubs secret-shaped
 * substrings from string content BEFORE persist, so the store never holds a raw secret.
 *
 * NOTE: there is no shared/velum redaction util in this codebase today, so the patterns
 * live here. They are intentionally HIGH-PRECISION (distinctive prefixes / labeled
 * assignments) rather than broad entropy heuristics — a false positive would mangle a
 * legitimate freeform activity note (e.g. a commit SHA, "ikbi fixed the parser"), and the
 * open `value` shape is deliberate. If another module later needs the same scrub, lift
 * these into a shared core util rather than duplicating them.
 */

/** The marker substituted for a detected secret. */
export const REDACTION_MARKER = "[REDACTED]";

/**
 * Secret SHAPES to scrub. Prefix-/label-anchored on purpose (precision over recall):
 * we only redact things that look unmistakably like credentials, never high-entropy
 * blobs in general (a 40-char hex commit SHA is legitimate activity content, not a
 * secret) — so legitimate freeform notes and structural pattern entries round-trip clean.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/…).
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // OpenAI-style secret keys (sk-…, sk-proj-…).
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Google API key.
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // Slack tokens (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWT (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // "Bearer <token>" (space-separated auth header form).
  /\bBearer\s+[A-Za-z0-9_\-./+=]{12,}/gi,
  // Labeled inline assignment: api_key=…, secret: "…", password=…, token=…, etc.
  /\b(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token|token|authorization)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
];

/** Redact every secret-shaped substring in one string. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTION_MARKER);
  return out;
}

/**
 * Recursively scrub secrets from any value: strings are redacted; arrays/objects are
 * walked; numbers/booleans/null/etc. pass through unchanged. Returns a NEW structure
 * (the input is not mutated). Object keys are preserved verbatim (only string VALUES are
 * scrubbed — the open shape is intentional).
 */
export function scrubSecrets<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubSecrets(v);
    return out as unknown as T;
  }
  return value;
}

/** Serialized UTF-8 byte size of a value (the size-cap measure). Unserializable ⇒ Infinity (reject). */
export function valueByteSize(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}
