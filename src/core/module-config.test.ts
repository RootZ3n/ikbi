import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { test } from "node:test";

import { moduleEnv } from "./module-config.js";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

test("auto-prefixes every key with IKBI_<MODULE>_ (per-module namespace)", () => {
  const r = moduleEnv("network-egress", env({ IKBI_NETWORK_EGRESS_ALLOWLIST: "a,b" }));
  assert.equal(r.prefix, "IKBI_NETWORK_EGRESS_");
  assert.equal(r.key("ALLOWLIST"), "IKBI_NETWORK_EGRESS_ALLOWLIST");
  assert.deepEqual(r.list("ALLOWLIST"), ["a", "b"]);
});

test("a module reader cannot read another module's (or a core) var", () => {
  const e = env({ IKBI_PORT: "9", IKBI_CACHING_MAX: "5", IKBI_EGRESS_MAX: "7" });
  // The egress reader only sees IKBI_EGRESS_*; it has no key that reaches IKBI_PORT
  // or another module's IKBI_CACHING_MAX.
  assert.equal(moduleEnv("egress", e).int("MAX", 0), 7);
  assert.equal(moduleEnv("caching", e).int("MAX", 0), 5);
  assert.equal(moduleEnv("egress", e).key("PORT"), "IKBI_EGRESS_PORT"); // never bare IKBI_PORT
});

test("typed accessors: str/required/bool/int/number/list/path", () => {
  const r = moduleEnv("sample", env({
    IKBI_SAMPLE_NAME: "  hi  ",
    IKBI_SAMPLE_ON: "yes",
    IKBI_SAMPLE_N: "42",
    IKBI_SAMPLE_F: "1.5",
    IKBI_SAMPLE_ITEMS: " x , y ,, z ",
    IKBI_SAMPLE_DIR: "rel/dir",
  }));
  assert.equal(r.str("NAME"), "hi", "trimmed");
  assert.equal(r.str("MISSING", "def"), "def");
  assert.equal(r.str("MISSING"), undefined);
  assert.equal(r.required("NAME"), "hi");
  assert.equal(r.bool("ON", false), true);
  assert.equal(r.bool("MISSING", true), true);
  assert.equal(r.int("N", 0), 42);
  assert.equal(r.number("F", 0), 1.5);
  assert.deepEqual(r.list("ITEMS"), ["x", "y", "z"], "trimmed, blanks dropped");
  assert.deepEqual(r.list("MISSING", ["d"]), ["d"]);
  assert.equal(isAbsolute(r.path("DIR", "fallback") as string), true, "relative resolved to absolute");
});

test("fail-loud parsing: required/bool/int throw clear, prefixed errors", () => {
  assert.throws(() => moduleEnv("sample", env({})).required("KEY"), /IKBI_SAMPLE_KEY/);
  assert.throws(() => moduleEnv("sample", env({ IKBI_SAMPLE_B: "maybe" })).bool("B", false), /IKBI_SAMPLE_B/);
  assert.throws(() => moduleEnv("sample", env({ IKBI_SAMPLE_N: "x" })).int("N", 0), /IKBI_SAMPLE_N/);
});

test("int bounds are enforced (inclusive)", () => {
  const e = env({ IKBI_SAMPLE_N: "5" });
  assert.equal(moduleEnv("sample", e).int("N", 0, { min: 0, max: 10 }), 5);
  assert.throws(() => moduleEnv("sample", e).int("N", 0, { min: 6 }), /below minimum/);
  assert.throws(() => moduleEnv("sample", e).int("N", 0, { max: 4 }), /above maximum/);
});

test("an invalid module name is rejected", () => {
  assert.throws(() => moduleEnv("Bad Name"), /invalid module name/);
  assert.throws(() => moduleEnv("UPPER"), /invalid module name/);
});

test("blank values are treated as absent (use the fallback)", () => {
  const r = moduleEnv("sample", env({ IKBI_SAMPLE_X: "   " }));
  assert.equal(r.str("X", "fallback"), "fallback");
  assert.equal(r.int("X", 99), 99);
});
