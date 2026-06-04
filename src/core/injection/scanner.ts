/**
 * ikbi prompt-injection chokepoint — the scanner.
 *
 * Detects known injection patterns and reports an HONEST verdict plus findings.
 * It never claims certainty: a `clean` verdict means "no known pattern matched",
 * not "proven safe". Scanning informs (logs, suspicion, gating); the wrap is what
 * actually protects, and it is applied regardless of the verdict.
 *
 * All patterns are linear (bounded quantifiers, no nested backtracking) so a
 * hostile input cannot trigger catastrophic regex backtracking (ReDoS).
 */

import { config } from "../config.js";
import type {
  InjectionCategory,
  InjectionFinding,
  FindingSeverity,
  NeutralizeOptions,
  RecommendedAction,
  ScanResult,
  ScanVerdict,
} from "./contract.js";
import { FENCE_MARKER } from "./fence.js";

interface Rule {
  readonly id: string;
  readonly category: InjectionCategory;
  readonly severity: FindingSeverity;
  /** Confidence (0..1) that a match is a real injection attempt — deliberately not 1.0. */
  readonly confidence: number;
  readonly description: string;
  readonly pattern: RegExp;
}

/** Cap matches recorded per rule so a flood of hits can't blow up the findings list. */
const MAX_MATCHES_PER_RULE = 5;

// The fence marker family, as a regex-safe literal, so we can detect attempts to
// forge ikbi's own wrapper markers inside untrusted content.
const FENCE_MARKER_RE = FENCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RULES: readonly Rule[] = [
  {
    id: "ignore_previous_instructions",
    category: "instruction_override",
    severity: "high",
    confidence: 0.85,
    description: "phrase attempting to override prior instructions",
    pattern:
      /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^\n]{0,30}\b(instruction|prompt|context|rule|direction|system)/gi,
  },
  {
    id: "you_are_now",
    category: "role_confusion",
    severity: "high",
    confidence: 0.7,
    description: "attempt to reassign the model's role/persona",
    pattern: /\byou\s+are\s+now\b[^\n]{0,40}/gi,
  },
  {
    id: "new_instructions",
    category: "role_confusion",
    severity: "medium",
    confidence: 0.55,
    description: "declaration of new system instructions/persona",
    pattern: /\bnew\s+(system\s+)?(instruction|prompt|persona|role|directive)/gi,
  },
  {
    id: "pretend_act_as",
    category: "role_confusion",
    severity: "low",
    confidence: 0.35,
    description: "role-play framing (pretend / act as)",
    pattern: /\b(pretend\s+to\s+be|act\s+as|roleplay\s+as)\b[^\n]{0,30}/gi,
  },
  {
    id: "fake_role_tag",
    category: "fake_delimiter",
    severity: "high",
    confidence: 0.6,
    description: "forged role tag (e.g. </system>, <assistant>)",
    pattern: /<\/?\s*(system|assistant|user|tool|developer)\s*>/gi,
  },
  {
    id: "chatml_marker",
    category: "fake_delimiter",
    severity: "high",
    confidence: 0.75,
    description: "chat-template control token (ChatML <|...|>)",
    pattern: /<\|[^|>\n]{0,40}\|>/g,
  },
  {
    id: "llama_inst_marker",
    category: "fake_delimiter",
    severity: "medium",
    confidence: 0.55,
    description: "Llama-style instruction/system markers ([INST], <<SYS>>)",
    pattern: /\[\/?INST\]|<<\/?\s*SYS\s*>>/gi,
  },
  {
    id: "fake_system_header",
    category: "fake_delimiter",
    severity: "medium",
    confidence: 0.5,
    description: "forged system-prompt header or role JSON",
    pattern: /\bBEGIN\s+SYSTEM\s+PROMPT\b|"role"\s*:\s*"(system|developer)"/gi,
  },
  {
    id: "system_prompt_leak",
    category: "system_prompt_leak",
    severity: "high",
    confidence: 0.7,
    description: "attempt to reveal/repeat the system prompt or instructions",
    pattern:
      /\b(reveal|repeat|print|show|output|leak|disclose|tell\s+me)\b[^\n]{0,30}\b(system\s+prompt|your\s+(instruction|prompt|rule)|initial\s+prompt|prompt\s+above)/gi,
  },
  {
    id: "forge_ikbi_fence",
    category: "delimiter_breaking",
    severity: "high",
    confidence: 0.8,
    description: "content contains ikbi's own untrusted-fence marker (forge attempt)",
    pattern: new RegExp(`${FENCE_MARKER_RE}|END\\s+UNTRUSTED\\s+DATA|<\\/?untrusted>`, "gi"),
  },
  {
    id: "encoded_payload",
    category: "encoded_payload",
    severity: "low",
    confidence: 0.2,
    description: "long base64-like run that may conceal a payload (informational)",
    pattern: /\b[A-Za-z0-9+/]{60,}={0,2}\b/g,
  },
  {
    id: "data_exfiltration",
    category: "tool_abuse",
    severity: "medium",
    confidence: 0.45,
    description: "attempt to exfiltrate data to an external destination",
    pattern:
      /\b(exfiltrate|send|post|upload|leak)\b[^\n]{0,30}\b(https?:\/\/|webhook|endpoint|api[_\s-]?key|secret|credential|token)/gi,
  },
];

/** Strip control chars, collapse whitespace, and bound length for safe logging. */
function sanitizeExcerpt(raw: string, max: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function decideVerdict(findings: readonly InjectionFinding[]): ScanVerdict {
  if (findings.some((f) => f.severity === "high" && f.confidence >= 0.7)) return "detected";
  if (findings.length > 0) return "suspicious";
  return "clean";
}

function recommend(verdict: ScanVerdict): RecommendedAction {
  return verdict === "detected" ? "block" : verdict === "suspicious" ? "review" : "proceed";
}

/** Zero-width, bidi, soft-hyphen, BOM and similar invisible/evasion characters. */
const EVASION_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Normalize content for pattern matching only (NOT for the wrapped body). NFKC
 * folds fullwidth/compatibility homoglyphs (ｉｇｎｏｒｅ -> ignore); stripping
 * zero-width / bidi / BOM characters defeats split-token evasion ("i<ZWSP>gnore" ->
 * ignore). True cross-script homoglyphs are a documented limitation.
 */
function normalizeForScan(s: string): string {
  return s.normalize("NFKC").replace(EVASION_CHARS, "");
}

/** Slice a string to at most `maxBytes` UTF-8 bytes (may end mid-char; fine for scanning). */
function sliceToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8");
}

/**
 * Scan content for injection patterns. Wrapping does not depend on this — the
 * scan only informs the verdict/findings. Content beyond `maxScanBytes` is not
 * scanned and the result is marked `truncated` (honest about coverage).
 */
export function scanForInjection(content: string, opts?: NeutralizeOptions): ScanResult {
  const maxBytes = opts?.maxScanBytes ?? config.injection.maxScanBytes;
  const excerptMax = opts?.excerptMaxChars ?? config.injection.excerptMaxChars;

  // Byte-accurate cap (not UTF-16 code units) for correct audit/receipts.
  const totalBytes = Buffer.byteLength(content, "utf8");
  const truncated = totalBytes > maxBytes;
  const slice = truncated ? sliceToBytes(content, maxBytes) : content;
  const scannedBytes = Buffer.byteLength(slice, "utf8");
  // Match against a normalized view so zero-width / bidi / fullwidth evasion fails.
  const text = normalizeForScan(slice);

  const findings: InjectionFinding[] = [];
  for (const rule of RULES) {
    // Fresh regex per scan so lastIndex state never leaks between calls.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        rule: rule.id,
        description: rule.description,
        category: rule.category,
        severity: rule.severity,
        confidence: rule.confidence,
        index: m.index,
        excerpt: sanitizeExcerpt(m[0], excerptMax),
      });
      count += 1;
      if (count >= MAX_MATCHES_PER_RULE) break;
      if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-length matches
    }
  }

  const maxConfidence = findings.reduce((acc, f) => Math.max(acc, f.confidence), 0);
  const verdict = decideVerdict(findings);
  return {
    verdict,
    recommendedAction: recommend(verdict),
    findings,
    maxConfidence,
    scannedBytes,
    truncated,
  };
}
