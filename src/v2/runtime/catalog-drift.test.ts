/**
 * DRIFT GUARDS — v2's catalog knowledge must not quietly diverge from v1's reality.
 *
 * v2 re-declares two things v1 also declares: the shipped built-in catalog, and the
 * provider auto-discovery mapping. That duplication is deliberate (see
 * model-catalog.ts — v1's assembled registry is preference-contaminated and cannot be
 * un-contaminated downstream), which makes it exactly the kind of duplication that rots
 * silently. So it is guarded at the source.
 *
 * These tests READ v1's source and compare it to v2's declarations. They fail when a
 * built-in model is added, removed or rerouted, when a shipped tier default changes, or
 * when an auto-discovery mapping changes — and the failure message says what to update.
 *
 * They deliberately depend on NO operator preference: the file text is the same whatever
 * this machine is configured to prefer.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { V2_AUTO_DISCOVERY_FACTS, V2_BUILTIN_CATALOG, V2_SHIPPED_TIER_DEFAULTS } from "./model-catalog.js";

const PROVIDER_INDEX = fileURLToPath(new URL("../../core/provider/index.ts", import.meta.url));
const PROVIDER_IDS = fileURLToPath(new URL("../../core/provider/providers/index.ts", import.meta.url));
const CORE_CONFIG = fileURLToPath(new URL("../../core/config.ts", import.meta.url));

const providerSource = (): string => readFileSync(PROVIDER_INDEX, "utf8");
const configSource = (): string => readFileSync(CORE_CONFIG, "utf8");

const UPDATE = "update src/v2/runtime/model-catalog.ts to match, then update this guard";

/**
 * Extract the balanced `[...]` / `{...}` VALUE assigned at `marker`.
 *
 * The search starts after the `= ` rather than at the marker, because the declarations
 * this reads carry inline type literals (`ModelSpec[]`, `Record<string, { … }>`) whose
 * brackets would otherwise be mistaken for the value.
 */
function blockAfter(source: string, marker: string, open: "[" | "{"): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find "${marker}" in v1 source — the guard needs updating`);
  const assign = source.indexOf("= ", start);
  assert.notEqual(assign, -1, `could not find the assignment for "${marker}"`);
  const from = source.indexOf(open, assign);
  assert.notEqual(from, -1, `could not find "${open}" after "${marker}"`);
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  assert.fail(`unbalanced ${open} after "${marker}"`);
}

/**
 * Provider-id constants v1's built-in routes are written in terms of, read from source
 * rather than imported. Reading keeps this guard a pure text comparison — and keeps v2
 * from acquiring a runtime dependency on a v1 module purely to police it.
 */
function providerTokens(source: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const text of [source, readFileSync(PROVIDER_IDS, "utf8")]) {
    for (const m of text.matchAll(/^(?:export )?const (\w+_PROVIDER_ID) = "([^"]+)";/gm)) {
      tokens[m[1]!] = m[2]!;
    }
  }
  assert.ok(tokens.STUB_PROVIDER_ID !== undefined, "STUB_PROVIDER_ID is no longer a string-literal constant");
  assert.ok(tokens.MIMO_PROVIDER_ID !== undefined, "provider-id constants are no longer string literals");
  return tokens;
}

/** Resolve a v1 route token: a `"literal"`, a provider-id constant, or a tier variable. */
function resolveToken(raw: string, tokens: Record<string, string>, tiers: { driver: string; critic: string }): string {
  const literal = /^"([^"]*)"$/.exec(raw);
  if (literal?.[1] !== undefined) return literal[1];
  if (raw in tokens) return tokens[raw]!;
  if (raw === "driver") return tiers.driver;
  if (raw === "critic") return tiers.critic;
  assert.fail(`unrecognized token "${raw}" in v1's built-in catalog — ${UPDATE}`);
}

/** v1's shipped tier defaults, read from the `?? "…"` fallbacks in core/config.ts. */
function shippedTierDefaults(): { driver: string; critic: string } {
  const source = configSource();
  const driver = /optStr\(env\.IKBI_MODEL_DRIVER\)\s*\?\?\s*"([^"]+)"/.exec(source);
  const critic = /optStr\(env\.IKBI_MODEL_CRITIC\)\s*\?\?\s*"([^"]+)"/.exec(source);
  assert.ok(driver?.[1] !== undefined && critic?.[1] !== undefined, "v1's shipped tier defaults are no longer literal fallbacks");
  return { driver: driver[1], critic: critic[1] };
}

/** v1's built-in catalog, as declared: id + ordered routes, with tokens resolved. */
function v1Builtins(): { id: string; routes: string[] }[] {
  const source = providerSource();
  const block = blockAfter(source, "const defaultModels: ModelSpec[] =", "[");
  const tokens = providerTokens(source);
  const tiers = shippedTierDefaults();
  const entries: { id: string; routes: string[] }[] = [];
  // Entries are separated by their `id:` field; split on it and parse each chunk.
  const parts = block.split(/^ {4}\{$/m).slice(1);
  assert.ok(parts.length > 0, `could not split v1's built-in entries — ${UPDATE}`);
  for (const part of parts) {
    const idRaw = /^\s*id:\s*([^,\n]+),/m.exec(part)?.[1]?.trim();
    if (idRaw === undefined) continue;
    const routes = [...part.matchAll(/\{\s*provider:\s*([^,]+),\s*providerModelId:\s*([^\s}]+)\s*\}/g)].map(
      (m) => `${resolveToken(m[1]!.trim(), tokens, tiers)}/${resolveToken(m[2]!.trim(), tokens, tiers)}`,
    );
    entries.push({ id: resolveToken(idRaw, tokens, tiers), routes });
  }
  return entries;
}

/** v1's auto-discovery mapping, gated by the providers it actually checks for a key. */
function v1AutoDiscovery(): { providerId: string; modelId: string; role: string; providerModelId: string }[] {
  const source = providerSource();
  const table = blockAfter(source, "const AUTO_DISCOVER:", "{");
  const checks = blockAfter(source, "const providerChecks:", "[");
  const checked = new Set([...checks.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]!));
  const out: { providerId: string; modelId: string; role: string; providerModelId: string }[] = [];
  for (const m of table.matchAll(
    /(\w+):\s*\{\s*modelId:\s*"([^"]+)",\s*role:\s*"([^"]+)",\s*providerModelId:\s*"([^"]+)"/g,
  )) {
    const providerId = m[1]!;
    // v1 only ever discovers a provider it also checks for a credential.
    if (!checked.has(providerId)) continue;
    out.push({ providerId, modelId: m[2]!, role: m[3]!, providerModelId: m[4]! });
  }
  return out;
}

// ── the guards ──────────────────────────────────────────────────────────────

test("drift: the extractors are not vacuous", () => {
  // A guard that silently parsed nothing would pass everything below it.
  assert.ok(v1Builtins().length >= 5, "v1's built-in catalog was not parsed");
  assert.ok(v1AutoDiscovery().length >= 3, "v1's auto-discovery table was not parsed");
  assert.ok(v1Builtins().every((e) => e.routes.length > 0), "routes were not parsed");
});

test("drift: v2's shipped tier defaults match v1's", () => {
  assert.deepEqual({ ...V2_SHIPPED_TIER_DEFAULTS }, shippedTierDefaults(), `v1 changed its shipped tier defaults — ${UPDATE}`);
});

test("drift: v2's built-in catalog matches v1's shipped built-ins, ids AND routes", () => {
  const expected = v1Builtins()
    .map((e) => `${e.id} -> ${e.routes.join(", ")}`)
    .sort();
  const actual = V2_BUILTIN_CATALOG.map(
    (m) => `${m.id} -> ${m.routes.map((r) => `${r.providerId}/${r.providerModelId}`).join(", ")}`,
  ).sort();
  assert.deepEqual(actual, expected, `v1's built-in catalog changed — ${UPDATE}`);
});

test("drift: v2's auto-discovery facts match v1's mapping exactly", () => {
  const expected = v1AutoDiscovery()
    .map((f) => `${f.providerId}: ${f.modelId} (${f.role}) -> ${f.providerModelId}`)
    .sort();
  const actual = V2_AUTO_DISCOVERY_FACTS.map((f) => `${f.providerId}: ${f.modelId} (${f.role}) -> ${f.providerModelId}`).sort();
  assert.deepEqual(actual, expected, `v1's auto-discovery mapping changed — ${UPDATE}`);
});

test("drift: the guard reads FILE TEXT, so no operator preference can influence it", () => {
  const before = v1Builtins();
  const saved = process.env.IKBI_MODEL_DRIVER;
  try {
    process.env.IKBI_MODEL_DRIVER = "a-preference-that-should-change-nothing";
    assert.deepEqual(v1Builtins(), before);
  } finally {
    if (saved === undefined) delete process.env.IKBI_MODEL_DRIVER;
    else process.env.IKBI_MODEL_DRIVER = saved;
  }
});
