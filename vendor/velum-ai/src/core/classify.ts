/**
 * Velum — Classification Engine
 * ============================================================
 * Classifies a single message into one trust category, redacting credentials
 * (and stashing them in the credential buffer) before they can reach a model.
 *
 * Priority:
 *   1. Credentials   → redact + buffer  → CREDENTIAL
 *   2. Injection     → flag             → PROMPT_INJECTION / INSTRUCTION_OVERRIDE / …
 *   3. Otherwise     → pass             → SAFE
 *
 * Credential + injection no longer downgrades to credential-only: after the
 * secret is redacted, the sanitized text is re-scanned for injection so both
 * signals survive (H3). Injection scanning runs over a normalized copy so
 * leetspeak / base64 / zero-width tricks can't slip past (H9).
 *
 * Known-safe terms (registry.neverRedact) and module/class-like tokens are
 * filtered out of LOW-confidence credential matches only; HIGH-confidence
 * matches (sk-…, AKIA…, ghp_…) are never suppressed (H6).
 * ============================================================
 */

import { registry as defaultRegistry, ensureGlobal, type PatternRegistry } from "./patterns.js";
import { storeCredential } from "./credential-buffer.js";
import { normalizeForScanning } from "./normalize.js";
import { emitReceipt } from "./receipts.js";

export type Classification =
  | "SAFE"
  | "CREDENTIAL"
  | "PROMPT_INJECTION"
  | "INSTRUCTION_OVERRIDE"
  | "MEMORY_MANIPULATION"
  | "BOUNDARY_PROBE"
  | "UNSAFE_CONTENT";

export interface ClassificationResult {
  classification: Classification;
  action: "passed" | "redacted" | "flagged";
  sanitizedMessage: string;
  warnings: string[];
  patternsMatched: string[];
  credentialBufferIds: string[];
}

export interface ClassifyOptions {
  /** Store redacted credentials in the buffer (default true). */
  storeInBuffer?: boolean;
  /** Registry to draw patterns from (default: shared registry). */
  registry?: PatternRegistry;
}

const REDACTED = "[REDACTED-CREDENTIAL]";

const CREDENTIAL_WARNING =
  "Credential detected and secured. If this was for a tool setup, continue with your request and the tool will retrieve it automatically.";

// Maps an injection pattern name → the classification it implies.
const INJECTION_CLASSIFICATION: Record<string, Classification> = {
  ignore_instructions: "PROMPT_INJECTION",
  ignore_system_prompt: "PROMPT_INJECTION",
  disregard: "PROMPT_INJECTION",
  prior_instructions: "PROMPT_INJECTION",
  highest_priority: "PROMPT_INJECTION",
  hidden_prompt: "PROMPT_INJECTION",
  tool_output_says: "PROMPT_INJECTION",
  you_are_now: "INSTRUCTION_OVERRIDE",
  forget_everything: "INSTRUCTION_OVERRIDE",
  new_instructions: "INSTRUCTION_OVERRIDE",
  pretend_you_are: "INSTRUCTION_OVERRIDE",
  developer_message: "INSTRUCTION_OVERRIDE",
  system_message_override: "INSTRUCTION_OVERRIDE",
  no_restrictions: "BOUNDARY_PROBE",
  dan_mode: "BOUNDARY_PROBE",
  jailbreak: "BOUNDARY_PROBE",
  reveal_system_prompt: "BOUNDARY_PROBE",
  exfiltrate_secrets: "BOUNDARY_PROBE",
  simulation_mode: "BOUNDARY_PROBE",
  policy_override: "BOUNDARY_PROBE",
  repeat_text_above: "BOUNDARY_PROBE",
  encode_secrets: "BOUNDARY_PROBE",
  exfiltrate: "BOUNDARY_PROBE",
  memory_manipulation: "MEMORY_MANIPULATION",
};

const SEVERITY_RANK: Record<string, number> = { warn: 1, review: 2, block: 3 };

/**
 * True if a matched value should be treated as known-safe (never a credential).
 * Only applied to LOW-confidence patterns — distinctive high-confidence secrets
 * are never suppressed (H6).
 */
function isSafeMatch(value: string, neverRedact: Set<string>): boolean {
  const lower = value.toLowerCase();
  for (const safe of neverRedact) {
    if (lower.includes(safe)) return true;
  }
  // Dotted names like "gamekeeper.library" — module/class references.
  if (/^[a-z]+\.[a-z]+/.test(lower)) return true;
  // Triple-hyphenated tool ids like "peh-tool-name".
  if (/^[a-z]+-[a-z]+-[a-z]+$/.test(lower)) return true;
  return false;
}

function execAll(regex: RegExp, text: string): string[] {
  const re = ensureGlobal(regex);
  re.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
    // Guard against zero-length matches spinning forever.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  re.lastIndex = 0;
  return out;
}

interface InjectionHit {
  patterns: string[];
  classification: Classification;
  strongestRank: number;
}

/** Scan text (and a normalized copy) for injection patterns. */
function detectInjection(text: string, registry: PatternRegistry): InjectionHit {
  const normalized = normalizeForScanning(text);
  const patterns: string[] = [];
  let classification: Classification = "SAFE";
  let strongestRank = 0;

  for (const def of registry.injectionPatterns) {
    def.pattern.lastIndex = 0;
    const hit = def.pattern.test(text) || (normalized !== text && testNormalized(def.pattern, normalized));
    def.pattern.lastIndex = 0;
    if (!hit) continue;

    patterns.push(def.name);
    const rank = SEVERITY_RANK[def.severity] ?? 1;
    if (rank > strongestRank || classification === "SAFE") {
      strongestRank = Math.max(strongestRank, rank);
      classification = INJECTION_CLASSIFICATION[def.name] ?? "PROMPT_INJECTION";
    }
  }

  return { patterns, classification, strongestRank };
}

function testNormalized(pattern: RegExp, normalized: string): boolean {
  pattern.lastIndex = 0;
  const r = pattern.test(normalized);
  pattern.lastIndex = 0;
  return r;
}

export function classify(
  message: string,
  sessionId?: string,
  options: ClassifyOptions = {},
): ClassificationResult {
  void sessionId; // accepted for API symmetry / audit hooks; not used in core
  const registry = options.registry ?? defaultRegistry;
  const storeInBuffer = options.storeInBuffer !== false;

  const warnings: string[] = [];
  const patternsMatched: string[] = [];
  const credentialBufferIds: string[] = [];
  let sanitized = message ?? "";
  const source = message ?? "";

  // ── 1. Credential detection (highest priority) ──
  let foundCredential = false;
  for (const def of registry.credentialPatterns) {
    const matches = execAll(def.pattern, source);
    // High-confidence secrets are never suppressed by neverRedact (H6).
    const realMatches =
      def.confidence === "high"
        ? matches
        : matches.filter((v) => !isSafeMatch(v, registry.neverRedact));
    if (realMatches.length === 0) continue;

    foundCredential = true;
    patternsMatched.push(def.name);

    for (const value of realMatches) {
      if (storeInBuffer) {
        const idx = source.indexOf(value);
        const start = Math.max(0, idx - 30);
        const end = Math.min(source.length, idx + value.length + 30);
        const context = source.slice(start, end).split(value).join("[VALUE]");
        credentialBufferIds.push(storeCredential(def.name, value, context));
      }
      sanitized = sanitized.split(value).join(REDACTED);
    }
  }

  if (foundCredential) {
    warnings.push(CREDENTIAL_WARNING);
    // H3 — a credential and injection can ride in the same message. Re-scan the
    // sanitized text so the injection signal is not lost.
    const inj = detectInjection(sanitized, registry);
    if (inj.patterns.length > 0) {
      for (const p of inj.patterns) if (!patternsMatched.includes(p)) patternsMatched.push(p);
      warnings.push(`Injection patterns also detected after redaction: ${inj.patterns.join(", ")}`);
    }
    emitReceipt({
      stage: "input",
      decision: "CREDENTIAL",
      patterns: patternsMatched,
      counts: { redacted: credentialBufferIds.length },
      sessionId,
    });
    return {
      classification: "CREDENTIAL",
      action: "redacted",
      sanitizedMessage: sanitized,
      warnings,
      patternsMatched,
      credentialBufferIds,
    };
  }

  // ── 2. Injection / override detection (flag, don't redact) ──
  const inj = detectInjection(source, registry);
  if (inj.patterns.length > 0) {
    emitReceipt({ stage: "input", decision: inj.classification, patterns: inj.patterns, sessionId });
    return {
      classification: inj.classification,
      action: "flagged",
      sanitizedMessage: sanitized,
      warnings,
      patternsMatched: inj.patterns,
      credentialBufferIds: [],
    };
  }

  // ── 3. Safe ──
  emitReceipt({ stage: "input", decision: "SAFE", sessionId });
  return {
    classification: "SAFE",
    action: "passed",
    sanitizedMessage: sanitized,
    warnings: [],
    patternsMatched: [],
    credentialBufferIds: [],
  };
}
