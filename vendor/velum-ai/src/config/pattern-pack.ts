/**
 * Velum — Pattern Packs
 * ============================================================
 * A shareable, version-controlled bundle of detection patterns + safe terms.
 * Each ecosystem product ships its own pack instead of hand-coding addPattern()
 * calls. A pack is a JSON file:
 *
 *   {
 *     "name": "nusika",
 *     "version": "1.0.0",
 *     "patterns": [
 *       { "name": "x", "pattern": "REGEX_SOURCE", "flags": "gi",
 *         "category": "credential", "severity": "block", "description": "...",
 *         "confidence": "high" }
 *     ],
 *     "neverRedact": ["term1", "term2"]
 *   }
 *
 * `pattern` is a regex SOURCE string (not a /…/ literal) plus optional `flags`,
 * so packs stay pure JSON and never carry executable code.
 * ============================================================
 */

import { readFileSync } from "node:fs";

import type { PatternDefinition, PatternRegistry, PatternCategory, PatternSeverity, PatternConfidence } from "../core/patterns.js";

export interface PatternPackEntry {
  name: string;
  /** Regex source string (e.g. "ACME-[A-Z0-9]{20,}"). */
  pattern: string;
  /** Regex flags (default "g" for credential/pii so scan loops advance). */
  flags?: string;
  category: PatternCategory;
  severity: PatternSeverity;
  description: string;
  confidence?: PatternConfidence;
}

export interface PatternPack {
  name: string;
  version: string;
  patterns?: PatternPackEntry[];
  neverRedact?: string[];
}

const CATEGORIES = new Set(["credential", "injection", "pii", "policy"]);
const SEVERITIES = new Set(["block", "review", "warn"]);

/** Parse + validate a pattern-pack object (already JSON-decoded). */
export function parsePatternPack(raw: unknown, source = "<inline>"): PatternPack {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`pattern pack ${source}: must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") throw new Error(`pattern pack ${source}: missing 'name'`);
  if (typeof obj.version !== "string") throw new Error(`pattern pack ${source}: missing 'version'`);

  const patterns: PatternPackEntry[] = [];
  if (obj.patterns !== undefined) {
    if (!Array.isArray(obj.patterns)) throw new Error(`pattern pack ${source}: 'patterns' must be an array`);
    for (const p of obj.patterns) {
      const e = p as Record<string, unknown>;
      if (typeof e.name !== "string" || typeof e.pattern !== "string") {
        throw new Error(`pattern pack ${source}: each pattern needs string 'name' and 'pattern'`);
      }
      if (!CATEGORIES.has(e.category as string)) {
        throw new Error(`pattern pack ${source}: pattern '${e.name}' has invalid category '${String(e.category)}'`);
      }
      if (!SEVERITIES.has(e.severity as string)) {
        throw new Error(`pattern pack ${source}: pattern '${e.name}' has invalid severity '${String(e.severity)}'`);
      }
      // Validate the regex compiles before it ever reaches a scan loop.
      try {
        new RegExp(e.pattern as string, (e.flags as string) ?? "");
      } catch (err) {
        throw new Error(`pattern pack ${source}: pattern '${e.name}' has an invalid regex: ${(err as Error).message}`);
      }
      patterns.push({
        name: e.name,
        pattern: e.pattern as string,
        flags: typeof e.flags === "string" ? e.flags : undefined,
        category: e.category as PatternCategory,
        severity: e.severity as PatternSeverity,
        description: typeof e.description === "string" ? e.description : "",
        confidence: e.confidence === "high" || e.confidence === "low" ? e.confidence : undefined,
      });
    }
  }

  const neverRedact = Array.isArray(obj.neverRedact) ? obj.neverRedact.map(String) : [];
  return { name: obj.name, version: obj.version, patterns, neverRedact };
}

/** Read + parse a pattern pack from disk. */
export function loadPatternPack(path: string): PatternPack {
  const text = readFileSync(path, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`pattern pack ${path}: invalid JSON — ${(err as Error).message}`);
  }
  return parsePatternPack(json, path);
}

/** Convert a pack entry into a runtime PatternDefinition. */
export function entryToDefinition(e: PatternPackEntry): PatternDefinition {
  return {
    name: e.name,
    pattern: new RegExp(e.pattern, e.flags ?? ""),
    category: e.category,
    severity: e.severity,
    description: e.description,
    confidence: e.confidence,
  };
}

/** Apply a parsed pack to a registry: add patterns + merge neverRedact terms. */
export function applyPatternPack(pack: PatternPack, registry: PatternRegistry): void {
  for (const term of pack.neverRedact ?? []) registry.neverRedact.add(term.toLowerCase());
  for (const entry of pack.patterns ?? []) registry.addPattern(entryToDefinition(entry));
}
