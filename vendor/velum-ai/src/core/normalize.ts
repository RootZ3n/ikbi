/**
 * Velum — Normalization Pipeline (H9 / P3)
 * ============================================================
 * Adversaries hide injection inside encodings: leetspeak ("ign0re"), HTML
 * entities ("&amp;"), zero-width characters, Unicode look-alikes, and base64.
 * `normalizeForScanning` flattens all of those into a single scan target so the
 * injection patterns match the *intent*, not the surface form.
 *
 * Pipeline (applied to a working copy — the original is never mutated):
 *   1. Unicode NFKD normalization
 *   2. HTML entity decode (&amp; → &, &nbsp; → space, numeric entities)
 *   3. Zero-width character removal (U+200B/C/D, U+FEFF)
 *   4. Leetspeak normalization (0→o, 1→i, 3→e, 4→a, 5→s, 7→t)
 *   5. Whitespace collapse
 *   6. Base64 detection + decode (segments > 20 chars, printable result)
 *
 * The result joins the normalized text with any decoded base64 payloads so a
 * single pattern pass covers every variant. NEVER run this on text destined for
 * credential matching — leetspeak rewriting would corrupt real secrets.
 * ============================================================
 */

const ZERO_WIDTH = /[​‌‍﻿]/g;

// Named HTML entities Velum cares about (kept tiny — zero-dependency).
const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&tab;": " ",
  "&newline;": " ",
};

const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
};

/** Decode the named + numeric HTML entities relevant to injection hiding. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&[a-zA-Z]+;|&#x?[0-9a-fA-F]+;/g, (m) => {
    const lower = m.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower]!;
    const num = /^&#(x?)([0-9a-fA-F]+);$/i.exec(m);
    if (num) {
      const code = parseInt(num[2]!, num[1] ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
    }
    return m;
  });
}

/** Rewrite common leetspeak digits to their letter equivalents. */
function leetNormalize(text: string): string {
  return text.replace(/[013457]/g, (d) => LEET_MAP[d] ?? d);
}

/** True if a decoded string is mostly printable (so it's plausibly real text). */
function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160) printable++;
  }
  return printable / s.length >= 0.8;
}

/** Find base64-looking segments (> 20 chars) and decode the printable ones. */
function decodeBase64Segments(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9+/]{20,}={0,2}/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(text)) !== null && count < 20) {
    const seg = m[0];
    if (m.index === re.lastIndex) re.lastIndex++;
    // Standard base64 length is a multiple of 4 (with padding).
    if (seg.replace(/=+$/, "").length < 20) continue;
    try {
      const decoded = Buffer.from(seg, "base64").toString("utf-8");
      if (decoded.length >= 3 && decoded !== seg && isMostlyPrintable(decoded)) {
        out.push(decoded);
        count++;
      }
    } catch {
      // Not decodable — ignore.
    }
  }
  return out;
}

const SEGMENT_SEPARATOR = "\n\n";

/**
 * Normalize text for injection pattern matching. Returns the normalized form
 * joined with any decoded base64 payloads. Pure — never mutates the input.
 */
export function normalizeForScanning(text: string): string {
  const source = text ?? "";
  if (!source) return "";

  let norm = source;
  try {
    norm = norm.normalize("NFKD");
  } catch {
    // Malformed surrogate pairs — keep the original.
  }
  norm = decodeHtmlEntities(norm);
  norm = norm.replace(ZERO_WIDTH, "");
  const collapsed = leetNormalize(norm).replace(/\s+/g, " ").trim();

  // Decode base64 from both the raw source and the entity-decoded form.
  const decoded = [...decodeBase64Segments(source), ...decodeBase64Segments(norm)];

  const parts = [collapsed];
  for (const d of decoded) parts.push(d);
  return parts.join(SEGMENT_SEPARATOR);
}
