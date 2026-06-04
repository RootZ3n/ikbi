/**
 * ikbi prompt-injection chokepoint — THE FROZEN CONTRACT (#2).
 *
 * There is ONE chokepoint that ALL untrusted-content-into-model paths route
 * through. Untrusted content = anything not authored by ikbi or the trusted
 * operator: tool/MCP results, fetched web pages, file/repo contents, command
 * output, or content produced by another (non-operator) agent.
 *
 * What the chokepoint does, ALWAYS, in `neutralizeUntrusted`:
 *   1. Scan      — detect known injection patterns; emit an honest verdict +
 *                  findings. Telemetry only — see the gating note below.
 *   2. Defang    — on higher-risk sources, break dangerous prompt primitives
 *                  inside the body (ChatML/role tags/role prefixes) so they read
 *                  as inert text. Risk-aware, source-driven (see `defangByDefault`).
 *   3. Neutralize-wrap — fence the (defanged) content in the single canonical
 *                  form with a verified-absent random nonce, then carry it as a
 *                  STRUCTURALLY-ISOLATED data-role message, never concatenated
 *                  into a trusted-instruction message.
 *
 * HONEST GUARANTEE — what this does and does NOT promise:
 *   - PROVABLE: delimiter-containment. The fenced content cannot forge or escape
 *     the terminator (the nonce is verified absent from the content), so it
 *     cannot break out of the data region.
 *   - STRONG: primitive-defanging on high-risk sources neutralizes the specific
 *     control tokens models key on for role switching.
 *   - STRUCTURAL: untrusted content stays isolated from trusted instructions
 *     (its own data-role message), so it is never in instruction position.
 *   - RESIDUAL RISK (acknowledged): this does NOT prove the content cannot
 *     SEMANTICALLY influence the model. Fenced-but-intact hostile text ("ignore
 *     prior", fake transcripts, indirect injection) can still affect a model —
 *     smaller / preamble-drift-prone models especially. We do NOT claim untrusted
 *     content "cannot be mistaken for instructions". The scanner is telemetry;
 *     the fence + defang + isolation are the protection, and they reduce — not
 *     eliminate — semantic risk.
 *
 * Wrapping + isolation are UNCONDITIONAL — applied whether the scan is clean or
 * not. Scanning INFORMS; it must never be treated as proof of safety.
 *
 * This file is pure contract: types + version + the one typed error. The only
 * import is the frozen `AgentIdentity` seam from the provider contract, so the
 * chokepoint records which agent's content (and from which source) was handled.
 */

import type { AgentIdentity } from "../provider/contract.js";

/** Semantic version of the injection contract. Bump on breaking change. */
export const INJECTION_CONTRACT_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a piece of untrusted content came from. Drives how it is wrapped/scanned
 * and is recorded on receipts. Anything not on this list is `external`; if the
 * origin is genuinely unknown it is `unknown` — still treated as untrusted.
 */
export type ContentSource =
  | "tool_result" // output of a tool/function call
  | "mcp_result" // output from an MCP server
  | "web_fetch" // fetched web/page content
  | "file" // file contents read from disk
  | "repo" // repository content
  | "command_output" // stdout/stderr of an executed command
  | "agent" // content produced by another (non-operator) agent
  | "external" // generic external/untrusted source
  | "unknown"; // provenance unknown -> treat as untrusted

/** Provenance/context for a neutralization — ties to the frozen AgentIdentity. */
export interface UntrustedContext {
  /** The source type of the content. */
  readonly source: ContentSource;
  /** Which agent's content/handling this is (frozen AgentIdentity seam). */
  readonly identity?: AgentIdentity;
  /** Origin detail for receipts (URL, file path, tool name, command). Sanitized before use. */
  readonly origin?: string;
  /** Optional human-readable label. */
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Verdict on whether content appears to contain an injection attempt.
 *
 * GATING SEMANTICS (read before gating on this):
 *   - "clean"      — NO KNOWN PATTERN MATCHED. This is NOT a proof of safety and
 *                    MUST NOT be treated as one. Nothing may skip the fence/defang/
 *                    isolation because a scan came back clean.
 *   - "suspicious" — at least one low/medium-signal pattern matched; worth review,
 *                    elevated logging, or raising required trust.
 *   - "detected"   — a high-signal pattern matched; recommended to gate/block or
 *                    require explicit operator/elevated-trust approval.
 *
 * The scanner is TELEMETRY. Protection comes from fence + defang + isolation,
 * which are always applied regardless of verdict.
 */
export type ScanVerdict = "clean" | "suspicious" | "detected";

/** Recommended gating action derived from the verdict (advisory; protection is unconditional). */
export type RecommendedAction = "proceed" | "review" | "block";

/** Category of injection technique a finding belongs to. */
export type InjectionCategory =
  | "instruction_override" // "ignore previous instructions"
  | "role_confusion" // fake system/assistant role, "you are now ..."
  | "fake_delimiter" // forged chat/template markers, fake tool-result fences
  | "system_prompt_leak" // attempts to exfiltrate the system prompt
  | "encoded_payload" // base64/hex blobs that may hide instructions
  | "tool_abuse" // attempts to invoke tools / exfiltrate data
  | "delimiter_breaking"; // attempts to forge/close the wrapper or break out

/** Severity of a finding IF it represents a real attempt. */
export type FindingSeverity = "low" | "medium" | "high";

/**
 * A single scanner finding. Honest about confidence: `confidence` is the
 * scanner's estimate (0..1) that this match indicates an actual injection — it
 * never claims certainty it does not have. A `clean` verdict means "no known
 * pattern matched", NOT "proven safe".
 */
export interface InjectionFinding {
  /** Stable rule id, e.g. "ignore_previous_instructions". */
  readonly rule: string;
  /** Human-readable description of what matched. */
  readonly description: string;
  readonly category: InjectionCategory;
  readonly severity: FindingSeverity;
  /** Confidence (0..1) that this match is a real injection attempt. */
  readonly confidence: number;
  /** Byte offset in the scanned content where the match began. */
  readonly index: number;
  /** The matched excerpt — sanitized and length-bounded (untrusted -> safe for logs). */
  readonly excerpt: string;
}

/**
 * The result of scanning content for injection patterns.
 *
 * SCANNER LIMITATIONS (honest): pattern matching is English-oriented and
 * keyword-based. It is normalized against zero-width / bidi / fullwidth evasion
 * before matching, but it does NOT do deep semantic or multilingual detection,
 * and true cross-script homoglyphs may slip past. Deeper detection is parked as
 * a known limitation — the scanner is telemetry, not the protection layer.
 */
export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** Advisory gating action derived from the verdict. Protection is unconditional regardless. */
  readonly recommendedAction: RecommendedAction;
  readonly findings: readonly InjectionFinding[];
  /** Highest finding confidence (0 when no findings). */
  readonly maxConfidence: number;
  /** Number of UTF-8 bytes actually scanned. */
  readonly scannedBytes: number;
  /** True if scanning stopped at the size cap — coverage was partial (honest). */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Neutralize
// ---------------------------------------------------------------------------

/**
 * The output of the chokepoint: the single canonical safe form to embed into a
 * ModelRequest, plus the scan verdict and provenance for the audit trail.
 *
 * Between the fence markers the original content is byte-for-byte preserved, so
 * legitimate code/JSON/markdown remains usable; the fence is unforgeable, so the
 * content cannot escape or be mistaken for instructions.
 */
export interface NeutralizedContent {
  /** Nominal discriminant — this is a structured form, never a bare string to concat. */
  readonly kind: "ikbi/neutralized-untrusted";
  readonly contractVersion: string;
  /**
   * The canonical fenced safe form. Do NOT concatenate this into a trusted
   * instruction/system message. Use `toUntrustedMessage()` to carry it as an
   * isolated data-role message (the structurally-safe integration path).
   */
  readonly wrapped: string;
  /** The original content as received, unchanged (pre-defang, pre-truncation). */
  readonly raw: string;
  /** The (defanged and/or truncated) body that was actually placed inside the fence. */
  readonly body: string;
  /** The scan verdict for this content. */
  readonly scan: ScanResult;
  /** Provenance. */
  readonly source: ContentSource;
  readonly origin?: string;
  readonly label?: string;
  readonly identity?: AgentIdentity;
  /**
   * Opaque per-wrap fence id (the random nonce). Recorded for audit/receipts so
   * a neutralization can be correlated to its log entry. Not a secret after use.
   */
  readonly fenceId: string;
  /** UTF-8 byte length of the raw content as received. */
  readonly bytes: number;
  /** Whether risk-aware defanging was applied to the body. */
  readonly defangApplied: boolean;
  /** Count of dangerous primitives defanged (0 when none / lossless). */
  readonly defangedCount: number;
  /** True if the raw content exceeded the size cap and the body was truncated. */
  readonly truncated: boolean;
  /** UTF-8 bytes omitted by truncation (0 when not truncated). */
  readonly omittedBytes: number;
}

/** Options accepted by the chokepoint entry points. */
export interface NeutralizeOptions {
  /** Override the max bytes scanned (defaults to config). */
  readonly maxScanBytes?: number;
  /** Override the hard cap on raw content bytes accepted for wrapping (defaults to config). */
  readonly maxContentBytes?: number;
  /** Override the excerpt length cap (defaults to config). */
  readonly excerptMaxChars?: number;
  /**
   * Force risk-aware defanging on (true) or off (false). When omitted, the
   * default is source-driven (see `defangByDefault`) so a caller cannot forget
   * to defang a high-risk source.
   */
  readonly defang?: boolean;
  /**
   * Injectable nonce source (testing only). MUST be unpredictable in production;
   * the default uses crypto-strong randomness.
   */
  readonly nonceFn?: () => string;
}

/** Typed error raised only if the fence cannot establish its safety invariant. */
export class InjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectionError";
  }
}
