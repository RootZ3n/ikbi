/**
 * WHAT AUTHORIZES SUPERVISED-LOCAL EXECUTION.
 *
 * The rule these pin is narrow and worth stating plainly: an explicit mode selection authorizes
 * supervised-local work, and nothing else does. Not a configured endpoint, not a reachable one,
 * not a token sitting on disk. Reachability says a worker exists; it never says anyone agreed to
 * use it, and the distance between those two sentences is the whole of this file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readBokahliRuntimeConfig, type LocalExecutionPolicy } from "./index.js";

const BASE_ENV: NodeJS.ProcessEnv = { HOME: "/home/nobody", IKBI_BOKAHLI_BASE_URL: "http://127.0.0.1:9/v1" };

test("authorization: with NO policy and NO env, supervised-local is OFF", () => {
  // The compatibility-safe default. An unqualified artifact is refused rather than quietly taken.
  const c = readBokahliRuntimeConfig(BASE_ENV);
  assert.equal(c.supervisedLocal, false);
  assert.equal(c.requireQualified, false);
});

test("authorization: an explicit policy authorizes supervised-local WITHOUT the env var", () => {
  // The redundant second opt-in is gone. `--mode assist` already said this.
  const c = readBokahliRuntimeConfig(BASE_ENV, { supervisedLocal: true });
  assert.equal(c.supervisedLocal, true);
});

test("authorization: an explicit policy OVERRIDES the environment in both directions", () => {
  // A decision made at the point of use outranks a variable left in a shell profile.
  assert.equal(readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_SUPERVISED_LOCAL: "true" }, { supervisedLocal: false }).supervisedLocal, false);
  assert.equal(readBokahliRuntimeConfig({ ...BASE_ENV }, { supervisedLocal: true }).supervisedLocal, true);
});

test("authorization: the env var still works as an operator-controlled DEFAULT", () => {
  // It is a pre-existing, explicit, operator-owned policy field — kept, demoted to a default.
  assert.equal(readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_SUPERVISED_LOCAL: "true" }).supervisedLocal, true);
});

test("authorization: only the exact string `true` enables it — no truthy coercion", () => {
  for (const v of ["1", "yes", "TRUE", "True", "on", " true", ""]) {
    assert.equal(readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_SUPERVISED_LOCAL: v }).supervisedLocal, false, `${JSON.stringify(v)} must not authorize`);
  }
});

test("authorization: a REACHABLE endpoint is not an authority grant", () => {
  // There is no field here for reachability, health, or a token's existence to argue through: the
  // config is a function of the environment and the caller's policy, and of nothing observed.
  const c = readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_BASE_URL: "http://100.64.0.1:8080/v1" });
  assert.equal(c.supervisedLocal, false, "configuring an endpoint must not authorize using it");
  assert.ok(c.baseUrl !== undefined, "the endpoint is still configured — it just grants nothing");
});

test("authorization: requireQualified and supervisedLocal are REFUSED together, by name", () => {
  // Supervised-local exists to accept an UNQUALIFIED artifact under review, so a request that
  // demands qualification can never be satisfied by it. Refusing here names both halves.
  assert.throws(
    () => readBokahliRuntimeConfig(BASE_ENV, { supervisedLocal: true, requireQualified: true }),
    /cannot both hold/,
  );
  assert.throws(
    () => readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_SUPERVISED_LOCAL: "true", IKBI_BOKAHLI_REQUIRE_QUALIFIED: "true" }),
    /cannot both hold/,
  );
});

test("authorization: requireQualified alone still forbids unqualified execution", () => {
  const c = readBokahliRuntimeConfig(BASE_ENV, { requireQualified: true });
  assert.equal(c.requireQualified, true);
  assert.equal(c.supervisedLocal, false);
});

test("authorization: a malformed route mode fails closed, before any provider is built", () => {
  for (const routeMode of ["yolo", "AUTOMATIC", "EXACTLY", " AUTO"]) {
    assert.throws(() => readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_ROUTE_MODE: routeMode }), /must be AUTO, PROFILE or EXACT/i,
      `${JSON.stringify(routeMode)} must be refused`);
  }
  // Case is deliberately forgiving — the value is upper-cased before it is checked — because
  // "auto" and "AUTO" are the same operator intent, unlike "yolo", which is no intent at all.
  for (const routeMode of ["auto", "Auto", "AUTO", "exact"]) {
    assert.doesNotThrow(() => readBokahliRuntimeConfig({ ...BASE_ENV, IKBI_BOKAHLI_ROUTE_MODE: routeMode, IKBI_BOKAHLI_TARGET: "m" }));
  }
});

test("authorization: the credential file stays mandatory and is never taken from the policy", () => {
  // A policy that could carry a credential path would be a policy that could carry a credential.
  const policy = { supervisedLocal: true } as LocalExecutionPolicy;
  assert.equal(Object.prototype.hasOwnProperty.call(policy, "credentialFile"), false);
  const c = readBokahliRuntimeConfig(BASE_ENV, policy);
  assert.equal(c.credentialFile, "/home/nobody/.config/bokahli/token");
  assert.equal((policy as unknown as Record<string, unknown>)["token"], undefined);
});

test("authorization: the config carries a credential PATH, never a credential VALUE", () => {
  const c = readBokahliRuntimeConfig(BASE_ENV, { supervisedLocal: true, taskClass: "t", target: "m", baseUrl: "http://x/v1" });
  // `credentialFile` is a path the provider reads at construction; the secret itself never enters
  // this object, so a config that is logged or serialized cannot leak one.
  const keys = Object.keys(c).sort();
  for (const k of keys) {
    assert.ok(!/^(token|apiKey|secret|password|authorization|bearer)$/i.test(k), `config exposes a secret-valued field: ${k}`);
  }
  assert.equal(c.credentialFile, "/home/nobody/.config/bokahli/token");
  assert.ok(keys.includes("credentialFile"));
});
