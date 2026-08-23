/**
 * Profile module tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import type { Profile } from "./contract.js";

import {
  listProfiles,
  loadProfile,
  saveProfile,
  resolveProfile,
  getActiveProfileName,
  switchProfile,
  clearActiveProfile,
  installDefaultProfiles,
  validateProfile,
  profileToEnv,
  DEFAULT_PROFILES,
  type ProfileRegistry,
} from "./storage.js";

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-profiles-test-"));
}

function fakeRegistry(
  models: Record<string, string[]> = {},
  providers: string[] = [],
): ProfileRegistry {
  return {
    getModel: (id) => {
      const routes = models[id];
      if (routes === undefined) return undefined;
      return { id, role: "driver", cost: { promptPerMTok: 0, completionPerMTok: 0 }, providers: routes.map((p) => ({ provider: p, providerModelId: id })) } as any;
    },
    getProvider: (id) => {
      if (providers.includes(id)) return { id, ready: () => true } as any;
      return undefined;
    },
  };
}

// ── Storage ────────────────────────────────────────────────────────────────

test("listProfiles returns empty for missing dir", () => {
  assert.deepEqual(listProfiles("/nonexistent"), []);
});

test("saveProfile creates the file and listProfiles finds it", async () => {
  const state = tmpState();
  const profile: Profile = { name: "test", roles: { builder: { provider: "p", model: "m" } } };
  await saveProfile(state, profile);
  assert.deepEqual(listProfiles(state), ["test"]);
});

test("loadProfile returns the saved profile", async () => {
  const state = tmpState();
  const profile: Profile = { name: "test", roles: { builder: { provider: "p", model: "m" } }, description: "A test" };
  await saveProfile(state, profile);
  const loaded = loadProfile(state, "test");
  assert.equal(loaded?.name, "test");
  assert.equal(loaded?.description, "A test");
});

test("loadProfile returns undefined for missing profile", () => {
  assert.equal(loadProfile(tmpState(), "nope"), undefined);
});

// ── Active profile pointer ─────────────────────────────────────────────────

test("getActiveProfileName returns undefined when no pointer exists", () => {
  assert.equal(getActiveProfileName(tmpState()), undefined);
});

test("switchProfile writes the pointer on success", async () => {
  const state = tmpState();
  const reg = fakeRegistry({ m: ["p"] }, ["p"]);
  await saveProfile(state, { name: "ok", roles: { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } } });
  const result = await switchProfile(state, "ok", reg);
  assert.equal(result.success, true);
  assert.equal(getActiveProfileName(state), "ok");
});

test("switchProfile does NOT change the pointer on validation failure", async () => {
  const state = tmpState();
  const reg = fakeRegistry({}, []); // no models, no providers
  await saveProfile(state, { name: "bad", roles: { builder: { provider: "p", model: "m" } } });
  await saveProfile(state, { name: "good", roles: { builder: { provider: "p", model: "m" } } });
  await switchProfile(state, "good", reg); // set initial (will fail too, but let's test the pattern)
  // Actually, let's set it directly
  const { writeFile } = await import("node:fs/promises");
  const { activeProfilePath } = await import("./storage.js");
  await writeFile(activeProfilePath(state), "good\n");

  const result = await switchProfile(state, "bad", reg);
  assert.equal(result.success, false);
  const name = getActiveProfileName(state) ?? "UNSET"; assert.equal(name, "good", "pointer unchanged after failed switch");
});

test("clearActiveProfile removes the pointer", async () => {
  const state = tmpState();
  const { writeFile } = await import("node:fs/promises");
  const { activeProfilePath } = await import("./storage.js");
  await writeFile(activeProfilePath(state), "something\n");
  assert.equal(getActiveProfileName(state), "something");
  await clearActiveProfile(state);
  assert.equal(getActiveProfileName(state), undefined);
});

test("switchProfile fails for nonexistent profile", async () => {
  const state = tmpState();
  const reg = fakeRegistry();
  const result = await switchProfile(state, "nope", reg);
  assert.equal(result.success, false);
  assert.ok(result.validation.errors.length > 0); assert.match(result.validation.errors[0]!, /not found/i);
});

// ── Inheritance ────────────────────────────────────────────────────────────

test("resolveProfile merges child over parent", async () => {
  const state = tmpState();
  await saveProfile(state, {
    name: "base",
    roles: {
      builder: { provider: "a", model: "base-model" },
      critic: { provider: "a", model: "base-critic" },
    },
  });
  await saveProfile(state, {
    name: "child",
    extends: "base",
    roles: { builder: { provider: "b", model: "child-model" } },
  });

  const resolved = resolveProfile(state, "child");
  assert.equal(resolved?.roles?.builder?.model, "child-model", "child overrides builder");
  assert.equal(resolved?.roles?.critic?.model, "base-critic", "parent critic inherited");
});

test("resolveProfile returns undefined for missing parent", async () => {
  const state = tmpState();
  await saveProfile(state, { name: "orphan", extends: "nope", roles: {} });
  // Should still return the child (without parent merge)
  const resolved = resolveProfile(state, "orphan");
  assert.equal(resolved?.name, "orphan");
});

// ── Validation ─────────────────────────────────────────────────────────────

test("validateProfile passes when all required roles resolve", () => {
  const profile: Profile = {
    name: "ok",
    roles: { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } },
  };
  const reg = fakeRegistry({ m: ["p"] }, ["p"]);
  const result = validateProfile(profile, reg);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateProfile fails when required role is missing", () => {
  const profile: Profile = {
    name: "incomplete",
    roles: { builder: { provider: "p", model: "m" } }, // no critic
  };
  const reg = fakeRegistry({ m: ["p"] }, ["p"]);
  const result = validateProfile(profile, reg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("critic")));
});

test("validateProfile fails when model not in roster", () => {
  const profile: Profile = {
    name: "bad-model",
    roles: { builder: { provider: "p", model: "nonexistent" }, critic: { provider: "p", model: "m" } },
  };
  const reg = fakeRegistry({ m: ["p"] }, ["p"]);
  const result = validateProfile(profile, reg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("nonexistent")));
});

test("validateProfile fails when provider not registered", () => {
  const profile: Profile = {
    name: "bad-provider",
    roles: { builder: { provider: "ghost", model: "m" }, critic: { provider: "p", model: "m" } },
  };
  const reg = fakeRegistry({ m: ["p", "ghost"] }, ["p"]); // ghost model exists but provider not registered
  const result = validateProfile(profile, reg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("ghost")));
});

// ── Default profiles ───────────────────────────────────────────────────────

test("DEFAULT_PROFILES has mimo, deepseek, premium", () => {
  assert.ok(DEFAULT_PROFILES.mimo);
  assert.ok(DEFAULT_PROFILES.deepseek);
  assert.ok(DEFAULT_PROFILES.premium);
});

test("installDefaultProfiles creates files", async () => {
  const state = tmpState();
  const count = await installDefaultProfiles(state);
  assert.equal(count, 3);
  const names = listProfiles(state);
  assert.ok(names.includes("mimo"));
  assert.ok(names.includes("deepseek"));
  assert.ok(names.includes("premium"));
});

test("installDefaultProfiles is idempotent", async () => {
  const state = tmpState();
  await installDefaultProfiles(state);
  const count = await installDefaultProfiles(state);
  assert.equal(count, 0, "second install adds nothing");
});

// ── profileToEnv ───────────────────────────────────────────────────────────

test("profileToEnv maps roles to env vars", () => {
  const profile: Profile = {
    name: "test",
    roles: {
      classifier: { provider: "p", model: "driver-m" },
      builder: { provider: "p", model: "builder-m" },
      critic: { provider: "p", model: "critic-m" },
    },
  };
  const env = profileToEnv(profile);
  assert.equal(env.IKBI_MODEL_DRIVER, "driver-m");
  assert.equal(env.IKBI_MODEL_BUILDER, "builder-m");
  assert.equal(env.IKBI_MODEL_CRITIC, "critic-m");
});
