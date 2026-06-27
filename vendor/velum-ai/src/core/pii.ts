/**
 * Velum — PII Detection + Masking
 * ============================================================
 * Detects personally-identifiable information (email, phone, SSN, credit card,
 * IP, names) and applies one of three privacy levels:
 *
 *   Level 1 — Observe:  detect + log only, text unchanged
 *   Level 2 — Redact:   replace each value with a typed placeholder ([EMAIL_1]),
 *                       reversible via the returned placeholder map
 *   Level 3 — Sanitize: strip all PII to [REDACTED] (NOT reversible)
 *
 * Raw PII values are NEVER persisted — the detection log records type + count
 * only.
 *
 * False-positive guards (M5):
 *   - CREDIT_CARD matches must pass the Luhn checksum.
 *   - NAME detection is opt-in (detectNames) and requires a known first name
 *     or a nearby name cue ("name:", "contact:", "Mr.", …).
 * ============================================================
 */

import { registry as defaultRegistry, ensureGlobal, type PatternRegistry } from "./patterns.js";

export interface PiiDetection {
  type: string;
  value: string;
  start: number;
  end: number;
}

export type PiiLevel = 1 | 2 | 3; // Observe, Redact, Sanitize

export interface ScanPiiOptions {
  /** Enable NAME detection (default false — too noisy without context). */
  detectNames?: boolean;
}

export interface PiiResult {
  detections: Array<{ type: string; count: number }>;
  masked: boolean;
  level: PiiLevel;
  maskedText?: string;
  placeholderMap?: Map<string, string>;
}

// ── Detection log (in-memory, capped, type+count only) ───────────────────────

export interface PiiLogEntry {
  timestamp: string;
  level: PiiLevel;
  detections: Array<{ type: string; count: number }>;
  masked: boolean;
}

const MAX_LOG_ENTRIES = 500;
const detectionLog: PiiLogEntry[] = [];

export function getDetectionLog(): PiiLogEntry[] {
  return detectionLog;
}

export function clearDetectionLog(): void {
  detectionLog.length = 0;
}

function logDetections(level: PiiLevel, detections: Array<{ type: string; count: number }>, masked: boolean): void {
  if (detections.length === 0) return;
  detectionLog.push({ timestamp: new Date().toISOString(), level, detections, masked });
  while (detectionLog.length > MAX_LOG_ENTRIES) detectionLog.shift();
}

// ── False-positive guards (M5) ───────────────────────────────────────────────

/** Luhn checksum — real credit-card numbers satisfy it; random 16-digit runs don't. */
function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// A small set of common first names — enough to anchor NAME without a dictionary.
const COMMON_FIRST_NAMES = new Set(
  [
    "james", "john", "robert", "michael", "william", "david", "richard", "joseph", "thomas", "charles",
    "mary", "patricia", "jennifer", "linda", "elizabeth", "barbara", "susan", "jessica", "sarah", "karen",
    "jane", "emily", "emma", "olivia", "sophia", "ava", "isabella", "mia", "daniel", "matthew",
    "anthony", "mark", "paul", "steven", "andrew", "joshua", "kevin", "brian", "george", "edward",
    "carlos", "maria", "luis", "ana", "wei", "li", "chen", "yuki", "raj", "amit",
  ].map((n) => n.toLowerCase()),
);

const NAME_CUE = /(?:name|contact|attn|from|to|mr|mrs|ms|dr|prof)\W*$/i;

/** Decide whether a NAME match is real enough to keep. */
function isLikelyName(source: string, d: PiiDetection): boolean {
  const firstToken = d.value.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (COMMON_FIRST_NAMES.has(firstToken)) return true;
  const before = source.slice(Math.max(0, d.start - 16), d.start);
  return NAME_CUE.test(before);
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Scan text for PII. Returns non-overlapping detections sorted by position
 * descending (so callers can replace back-to-front without shifting indices).
 */
export function scanPii(
  text: string,
  registry: PatternRegistry = defaultRegistry,
  options: ScanPiiOptions = {},
): PiiDetection[] {
  const source = text ?? "";
  const raw: PiiDetection[] = [];

  for (const def of registry.piiPatterns) {
    const re = ensureGlobal(def.pattern);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      raw.push({ type: def.name, value: m[0], start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    re.lastIndex = 0;
  }

  // Per-type false-positive guards (M5).
  const filtered = raw.filter((d) => {
    if (d.type === "CREDIT_CARD") return passesLuhn(d.value);
    if (d.type === "NAME") return options.detectNames === true && isLikelyName(source, d);
    return true;
  });

  // Resolve overlaps: prefer earlier start, then the longer match.
  filtered.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));
  const kept: PiiDetection[] = [];
  let lastEnd = -1;
  for (const d of filtered) {
    if (d.start >= lastEnd) {
      kept.push(d);
      lastEnd = d.end;
    }
  }

  // Descending for safe back-to-front replacement.
  return kept.sort((a, b) => b.start - a.start);
}

function countByType(detections: PiiDetection[]): Array<{ type: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const d of detections) counts[d.type] = (counts[d.type] ?? 0) + 1;
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

// ── Masking (Level 2) ────────────────────────────────────────────────────────

/** Replace PII with reversible typed placeholders. Returns text + placeholder map. */
export function maskPii(
  text: string,
  registry: PatternRegistry = defaultRegistry,
  options: ScanPiiOptions = {},
): { text: string; placeholderMap: Map<string, string> } {
  const source = text ?? "";
  const detections = scanPii(source, registry, options); // descending by start
  const placeholderMap = new Map<string, string>();
  const valueToPlaceholder = new Map<string, string>();
  const typeCounters: Record<string, number> = {};

  let result = source;
  for (const d of detections) {
    let placeholder = valueToPlaceholder.get(d.value);
    if (!placeholder) {
      const idx = (typeCounters[d.type] ?? 0) + 1;
      typeCounters[d.type] = idx;
      placeholder = `[${d.type}_${idx}]`;
      valueToPlaceholder.set(d.value, placeholder);
      placeholderMap.set(placeholder, d.value);
    }
    result = result.slice(0, d.start) + placeholder + result.slice(d.end);
  }

  return { text: result, placeholderMap };
}

/** Restore placeholders to their original values. */
export function demask(text: string, placeholderMap: Map<string, string>): string {
  let result = text ?? "";
  for (const [placeholder, original] of placeholderMap) {
    result = result.split(placeholder).join(original);
  }
  return result;
}

// ── Sanitizing (Level 3) ─────────────────────────────────────────────────────

/** Strip all PII to [REDACTED]. Not reversible. */
export function sanitizePii(
  text: string,
  registry: PatternRegistry = defaultRegistry,
  options: ScanPiiOptions = {},
): string {
  const source = text ?? "";
  const detections = scanPii(source, registry, options); // descending by start
  let result = source;
  for (const d of detections) {
    result = result.slice(0, d.start) + "[REDACTED]" + result.slice(d.end);
  }
  return result;
}

// ── Level-aware processing ───────────────────────────────────────────────────

export function processWithPii(
  text: string,
  level: PiiLevel,
  registry: PatternRegistry = defaultRegistry,
  options: ScanPiiOptions = {},
): PiiResult {
  // L2 — reject invalid levels instead of silently sanitizing.
  if (level !== 1 && level !== 2 && level !== 3) {
    throw new RangeError(`processWithPii: level must be 1, 2, or 3, got ${String(level)}`);
  }

  const detections = scanPii(text, registry, options);
  const counts = countByType(detections);

  if (level === 1) {
    logDetections(1, counts, false);
    return { detections: counts, masked: false, level: 1 };
  }

  if (detections.length === 0) {
    logDetections(level, counts, false);
    return { detections: counts, masked: false, level };
  }

  if (level === 2) {
    const { text: maskedText, placeholderMap } = maskPii(text, registry, options);
    logDetections(2, counts, true);
    return { detections: counts, masked: true, level: 2, maskedText, placeholderMap };
  }

  // level === 3
  const maskedText = sanitizePii(text, registry, options);
  logDetections(3, counts, true);
  return { detections: counts, masked: true, level: 3, maskedText };
}
