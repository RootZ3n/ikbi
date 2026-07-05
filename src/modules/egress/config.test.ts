/**
 * egress config loader — the IKBI_EGRESS_ALLOWLIST override REPLACES the defaults by default
 * (so egress can be TIGHTENED below the built-ins), with a `+defaults` opt-in to keep the
 * built-ins AND add more. This mirrors the governed-exec `+defaults` token (#12): one syntax,
 * consistent meaning across both allowlists; the divergent DEFAULT is deliberate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_EGRESS_HOSTS, resolveEgressAllowlist } from "./config.js";

const lc = (xs: readonly string[]): string[] => xs.map((h) => h.toLowerCase());

test("no override → exactly the built-in defaults", () => {
  assert.deepEqual([...resolveEgressAllowlist([])], lc(DEFAULT_EGRESS_HOSTS));
});

test("a list WITHOUT `+defaults` REPLACES the defaults (tighten to exactly these hosts)", () => {
  const out = resolveEgressAllowlist(["api.foo.com", "bar.example"]);
  assert.deepEqual([...out], ["api.foo.com", "bar.example"]);
  // the built-in web-search host is intentionally GONE — this is the tightening lever.
  assert.equal(out.includes("html.duckduckgo.com"), false, "defaults are replaced, not merged");
});

test("#12: `+defaults` opts INTO additive — the built-ins are kept AND the operator's hosts added", () => {
  const out = resolveEgressAllowlist(["+defaults", "api.foo.com"]);
  for (const d of DEFAULT_EGRESS_HOSTS) assert.ok(out.includes(d.toLowerCase()), `default host "${d}" is kept`);
  assert.ok(out.includes("api.foo.com"), "the operator's host is added");
  assert.equal(out.includes("+defaults"), false, "the sentinel itself is not a host");
});

test("entries are lowercased, trimmed, de-duplicated, and empties dropped", () => {
  const out = resolveEgressAllowlist(["  API.Foo.com ", "api.foo.com", "", "  "]);
  assert.deepEqual([...out], ["api.foo.com"]);
});
