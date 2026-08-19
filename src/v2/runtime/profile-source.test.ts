/**
 * The profile adapter — the piece that turns v1's active-profile pointer from a
 * documentation generator into a real runtime input.
 *
 * Two things are pinned here: that inheritance still behaves EXACTLY as v1's
 * `resolveProfile` does for healthy chains (proved against the real function on a real
 * filesystem), and that every way a chain can be broken becomes a distinct, truthful
 * error instead of v1's silent degradation.
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Profile } from "../../modules/profiles/contract.js";
import { KNOWN_ROLES, REQUIRED_ROLES } from "../../modules/profiles/contract.js";
import { DEFAULT_PROFILES, resolveProfile } from "../../modules/profiles/storage.js";
import { V2_MODEL_ROLES, V2_REQUIRED_ROLES } from "../core/config.js";
import { fileProfileStore, readActiveProfile, type ProfileStore } from "./profile-source.js";

/** An in-memory store: the adapter's logic without a filesystem. */
function memoryStore(profiles: Record<string, Profile>, active?: string, malformed: readonly string[] = []): ProfileStore {
  return {
    activeName: () => active,
    load: (name) => profiles[name],
    exists: (name) => name in profiles || malformed.includes(name),
  };
}

const leaf = (name: string, extend?: string, roles: Record<string, { provider: string; model: string }> = {}): Profile => ({
  name,
  ...(extend !== undefined ? { extends: extend } : {}),
  roles,
});

// ── selection ───────────────────────────────────────────────────────────────

test("profile adapter: no pointer and no override is `none`, not an error", () => {
  assert.deepEqual(readActiveProfile(memoryStore({})), { kind: "none" });
});

test("profile adapter: the ACTIVE POINTER is read as a real runtime input", () => {
  const store = memoryStore({ mimo: leaf("mimo", undefined, { builder: { provider: "mimo", model: "m" } }) }, "mimo");
  const result = readActiveProfile(store);
  assert.ok(result.kind === "resolved");
  assert.equal(result.profile.name, "mimo");
  assert.equal(result.profile.source, "active_pointer");
});

test("profile adapter: a run override BEATS the standing pointer and is tagged as such", () => {
  const store = memoryStore({ mimo: leaf("mimo"), premium: leaf("premium") }, "mimo");
  const result = readActiveProfile(store, "premium");
  assert.ok(result.kind === "resolved");
  assert.equal(result.profile.name, "premium");
  assert.equal(result.profile.source, "run_override");
});

test("profile adapter: a blank override falls back to the pointer rather than to nothing", () => {
  const store = memoryStore({ mimo: leaf("mimo") }, "mimo");
  const result = readActiveProfile(store, "   ");
  assert.ok(result.kind === "resolved");
  assert.equal(result.profile.name, "mimo");
});

// ── inheritance ─────────────────────────────────────────────────────────────

test("profile adapter: inheritance merges child over parent and records the chain", () => {
  const store = memoryStore(
    {
      base: leaf("base", undefined, { builder: { provider: "p", model: "base-b" }, critic: { provider: "p", model: "base-c" } }),
      child: leaf("child", "base", { builder: { provider: "q", model: "child-b" } }),
    },
    "child",
  );
  const result = readActiveProfile(store);
  assert.ok(result.kind === "resolved");
  assert.deepEqual([...result.profile.inheritanceChain], ["child", "base"]);
  assert.equal(result.profile.roles.builder?.model, "child-b", "the child wins");
  assert.equal(result.profile.roles.critic?.model, "base-c", "the parent fills the gap");
});

test("profile adapter: a MISSING PARENT fails — v1 silently used the child without inheritance", () => {
  const store = memoryStore({ child: leaf("child", "ghost") }, "child");
  const result = readActiveProfile(store);
  assert.ok(result.kind === "unresolvable");
  assert.equal(result.code, "profile_parent_not_found");
  assert.match(result.detail, /ghost/);
});

test("profile adapter: a CYCLE is named, not walked", () => {
  const store = memoryStore({ a: leaf("a", "b"), b: leaf("b", "a") }, "a");
  const result = readActiveProfile(store);
  assert.ok(result.kind === "unresolvable");
  assert.equal(result.code, "profile_inheritance_cycle");
});

test("profile adapter: an over-deep chain is reported as such, not as 'not found'", () => {
  const profiles: Record<string, Profile> = {};
  for (let i = 0; i < 10; i += 1) profiles[`p${i}`] = leaf(`p${i}`, `p${i + 1}`);
  const result = readActiveProfile(memoryStore(profiles, "p0"));
  assert.ok(result.kind === "unresolvable");
  assert.equal(result.code, "profile_inheritance_too_deep");
});

// ── broken selections ───────────────────────────────────────────────────────

test("profile adapter: a pointer at a nonexistent profile is `profile_not_found`", () => {
  const result = readActiveProfile(memoryStore({}, "gone"));
  assert.ok(result.kind === "unresolvable");
  assert.equal(result.code, "profile_not_found");
});

test("profile adapter: a file that exists but will not parse is MALFORMED, not missing", () => {
  const result = readActiveProfile(memoryStore({}, "broken", ["broken"]));
  assert.ok(result.kind === "unresolvable");
  assert.equal(result.code, "profile_malformed");
});

test("profile adapter: a profile name that is a path is refused", () => {
  for (const bad of ["../../etc/passwd", "/etc/passwd", "a/b", ".hidden"]) {
    const result = readActiveProfile(memoryStore({}, bad));
    assert.ok(result.kind === "unresolvable", `${bad} is refused`);
    assert.equal(result.code, "profile_name_invalid", `${bad} is refused as a name, before any read`);
  }
});

// ── equivalence with the v1 donor ───────────────────────────────────────────

test("profile adapter: healthy inheritance matches v1's resolveProfile exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-profiles-"));
  try {
    mkdirSync(join(root, "profiles"), { recursive: true });
    for (const profile of Object.values(DEFAULT_PROFILES)) {
      writeFileSync(join(root, "profiles", `${profile.name}.json`), JSON.stringify(profile, null, 2));
    }
    // `premium` extends `mimo` — a real, non-degenerate chain from the shipped defaults.
    const v1 = resolveProfile(root, "premium");
    assert.ok(v1 !== undefined);
    const v2 = readActiveProfile(fileProfileStore(root), "premium");
    assert.ok(v2.kind === "resolved");
    assert.deepEqual(v2.profile.roles, v1.roles, "role merge is identical to v1's");
    assert.equal(v2.profile.routing?.cheapTier, v1.routing?.cheap_tier);
    assert.equal(v2.profile.routing?.fallbackProfile, v1.routing?.fallback_profile);
    assert.equal(v2.profile.maxRunCostUsd, v1.max_run_cost);
    assert.deepEqual([...v2.profile.inheritanceChain], ["premium", "mimo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile adapter: the real pointer file is what v2 reads", () => {
  const root = mkdtempSync(join(tmpdir(), "ikbi-v2-pointer-"));
  try {
    mkdirSync(join(root, "profiles"), { recursive: true });
    writeFileSync(join(root, "profiles", "solo.json"), JSON.stringify(leaf("solo", undefined, { builder: { provider: "p", model: "m" } })));
    const store = fileProfileStore(root);
    assert.deepEqual(readActiveProfile(store), { kind: "none" }, "no pointer yet");
    // This is byte-for-byte what v1's `switchProfile` writes.
    writeFileSync(join(root, "active-profile"), "solo\n");
    const after = readActiveProfile(store);
    assert.ok(after.kind === "resolved");
    assert.equal(after.profile.name, "solo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── vocabulary parity ───────────────────────────────────────────────────────

test("profile adapter: v2's role vocabulary has not drifted from v1's", () => {
  // v2 declares its own copy so `core/config.ts` imports no v1. This is the guard that
  // keeps the copy honest.
  assert.deepEqual([...V2_MODEL_ROLES], [...KNOWN_ROLES]);
  assert.deepEqual([...V2_REQUIRED_ROLES], [...REQUIRED_ROLES]);
});
