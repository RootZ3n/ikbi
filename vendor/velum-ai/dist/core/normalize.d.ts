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
/**
 * Normalize text for injection pattern matching. Returns the normalized form
 * joined with any decoded base64 payloads. Pure — never mutates the input.
 */
export declare function normalizeForScanning(text: string): string;
//# sourceMappingURL=normalize.d.ts.map