/**
 * Lenient parsing for model-emitted tool-call arguments.
 *
 * Cheap / local models frequently emit *near*-JSON for tool arguments — single-quoted
 * strings (`{'text':'hi'}`), Python literals (`True`/`False`/`None`), trailing commas,
 * unquoted keys, or a stray markdown fence. Strict `JSON.parse` rejects all of these, and
 * the transport used to silently fall back to `{}` — dropping the model's real arguments and
 * sending the call through with none. For a weak model that keeps re-emitting the same
 * near-JSON, that produces a useless result every round and the build stalls on "no_progress".
 *
 * This module is squarely on ikbi's thesis (give cheap models every advantage): try to REPAIR
 * the common malformations before giving up. Every repair is best-effort and *verified by
 * re-parsing* — if a repair does not yield valid JSON, we discard it, so a repair can never
 * turn a call into something the model did not intend. If nothing parses, the caller still
 * falls back to `{}` exactly as before.
 */

/** Result of a lenient parse: the value, and whether repair was needed to get it. */
export interface LenientParse {
  readonly value: unknown;
  readonly repaired: boolean;
}

/** Strip a wrapping markdown code fence (```json … ```), if present. */
function stripFence(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** Remove trailing commas before a closing `}` or `]`. */
function dropTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/** Replace bare Python literals with their JSON equivalents (word-boundary guarded). */
function pythonLiterals(s: string): string {
  return s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
}

/** Quote unquoted object keys: `{ key: … , foo: … }` → `{ "key": … , "foo": … }`. */
function quoteKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
}

/**
 * Attempt to parse tool-call arguments, repairing common near-JSON emitted by weak models.
 * Returns undefined when nothing parses (caller decides the fallback).
 */
export function parseLenientArgs(raw: string): LenientParse | undefined {
  // Fast path: already-valid JSON, no repair.
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch {
    /* fall through to repair */
  }

  // Build progressively-repaired candidates; the first that parses wins. Single-quote→double
  // is only applied when no double quotes are present, so we never clobber a legitimately
  // double-quoted string that merely contains an apostrophe.
  const base = stripFence(raw);
  const noTrailing = dropTrailingCommas(base);
  const pyFixed = pythonLiterals(noTrailing);
  const candidates: string[] = [base, noTrailing, pyFixed];

  if (!pyFixed.includes('"')) {
    const singleToDouble = pyFixed.replace(/'/g, '"');
    candidates.push(singleToDouble, quoteKeys(singleToDouble));
  }
  candidates.push(quoteKeys(pyFixed));

  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate), repaired: true };
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}
