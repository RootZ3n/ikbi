import assert from "node:assert/strict";
import { test } from "node:test";

// The provider registry and doctor modules use the fail-closed egress seam at import time.
import "../../modules/egress/index.js";

import { loadConfig } from "../config.js";
import { providerPreflightRoles, runProviderPreflightCli } from "../../cli/doctor.js";
import type { ModelProvider, ProviderPreflightInfo } from "./contract.js";
import { resolveProviderPreflight } from "./preflight.js";
import type { ProviderPreflightRegistry, ProviderPreflightRoleAssignment } from "./preflight.js";
import type { ModelSpec } from "./registry.js";

const SECRET = "SUPER-SECRET-PROVIDER-CREDENTIAL";

function cfg(extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    IKBI_ALLOW_INSECURE_DEV_KEYS: "true",
    IKBI_OPERATOR_TOKEN: "operator-token",
    IKBI_WORKER_TOKEN: "worker-token",
    IKBI_TRUST_HMAC_KEY: "hmac",
    IKBI_IDENTITY_TOKEN_SALT: "salt",
    IKBI_PROVIDER_CONFIG: "/tmp/ikbi-provider-preflight/providers.json",
    ...extra,
  });
}

function provider(id: string, info: ProviderPreflightInfo, ready = info.credentialPresent): ModelProvider {
  return {
    id,
    ready: () => ready,
    preflightInfo: () => info,
    invoke: async () => {
      throw new Error("provider invocation must not occur during local preflight");
    },
  };
}

function model(id: string, providerId: string): ModelSpec {
  return {
    id,
    cost: { promptPerMTok: 0, completionPerMTok: 0 },
    providers: [{ provider: providerId, providerModelId: id }],
  };
}

function registry(models: readonly ModelSpec[], providers: readonly ModelProvider[]): ProviderPreflightRegistry {
  const modelMap = new Map(models.map((entry) => [entry.id, entry]));
  const providerMap = new Map(providers.map((entry) => [entry.id, entry]));
  return {
    getModel: (id) => modelMap.get(id),
    getProvider: (id) => providerMap.get(id),
  };
}

const roles = (...entries: ProviderPreflightRoleAssignment[]): readonly ProviderPreflightRoleAssignment[] => entries;
const required = (role: string, modelId?: string): ProviderPreflightRoleAssignment => ({ role, required: true, ...(modelId === undefined ? {} : { model: modelId }), configurationSource: `IKBI_MODEL_${role.toUpperCase()}` });

const READY_INFO: ProviderPreflightInfo = {
  kind: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  credentialRequired: true,
  credentialPresent: true,
  credentialSource: "environment",
  configurationSource: "built-in provider config",
};

test("all required roles resolve locally with credentials and no invocation", () => {
  let invokes = 0;
  const p: ModelProvider = {
    id: "provider-a",
    ready: () => true,
    preflightInfo: () => READY_INFO,
    invoke: async () => {
      invokes += 1;
      throw new Error("unexpected invocation");
    },
  };
  const report = resolveProviderPreflight({
    config: cfg(),
    registry: registry([model("driver-model", "provider-a"), model("builder-model", "provider-a"), model("critic-model", "provider-a")], [p]),
    roles: roles(required("driver", "driver-model"), required("builder", "builder-model"), required("critic", "critic-model")),
  });
  assert.equal(report.status, "ready");
  assert.equal(report.remoteReachability, "not_checked");
  assert.equal(report.wouldStartPaidInvocation, false);
  assert.equal(report.issues.length, 0);
  assert.ok(report.roles.every((role) => role.ready && role.modelInRoster && role.providerInRoster && role.credentialPresent));
  assert.equal(invokes, 0);
});

test("missing model, provider, credential, and invalid endpoint receive stable local issue codes", () => {
  const missingCredential = provider("no-key", { ...READY_INFO, credentialPresent: false, credentialSource: "environment" }, false);
  const invalidEndpoint = provider("bad-endpoint", { ...READY_INFO, baseUrl: "not-an-endpoint" }, true);
  const report = resolveProviderPreflight({
    config: cfg(),
    registry: registry([
      model("missing-provider-model", "ghost-provider"),
      model("missing-credential-model", "no-key"),
      model("invalid-endpoint-model", "bad-endpoint"),
    ], [missingCredential, invalidEndpoint]),
    roles: roles(
      required("driver", "not-in-roster"),
      required("builder", "missing-provider-model"),
      required("critic", "missing-credential-model"),
      required("fixer", "invalid-endpoint-model"),
      { role: "rescue", required: true },
    ),
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(new Set(report.issues.map((issue) => issue.code)), new Set([
    "MODEL_NOT_IN_ROSTER",
    "PROVIDER_NOT_IN_ROSTER",
    "PROVIDER_CREDENTIAL_MISSING",
    "PROVIDER_CONFIGURATION_INVALID",
    "MODEL_NOT_CONFIGURED",
  ]));
  assert.ok(report.issues.every((issue) => issue.blocksBuild && issue.retryable === false && issue.recovery.length > 0));
});

test("optional unused roles do not block readiness", () => {
  const report = resolveProviderPreflight({
    config: cfg(),
    registry: registry([model("driver-model", "provider-a")], [provider("provider-a", READY_INFO)]),
    roles: roles(required("driver", "driver-model"), { role: "fixer", required: false }),
  });
  const fixer = report.roles.find((role) => role.role === "fixer");
  assert.equal(report.status, "ready");
  assert.equal(fixer?.ready, true);
  assert.equal(fixer?.issues.length, 0);
});

test("credential source is exposed without exposing credential contents", () => {
  const report = resolveProviderPreflight({
    config: cfg({ IKBI_MIMO_API_KEY: SECRET }),
    env: { IKBI_MIMO_API_KEY: SECRET },
    dotenvProvenance: new Map([["IKBI_MIMO_API_KEY", "/tmp/provider.env"]]),
    registry: registry([model("driver-model", "mimo")], [{
      id: "mimo",
      ready: () => true,
      invoke: async () => { throw new Error("unexpected invocation"); },
    }]),
    roles: roles(required("driver", "driver-model")),
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(report.roles[0]?.credentialSource, ".env (/tmp/provider.env)");
  assert.equal(report.resolvedConfiguration.sources.find((source) => source.key === "IKBI_MIMO_API_KEY")?.source, ".env (/tmp/provider.env)");
});

test("multiple simultaneous role issues are retained rather than collapsed", () => {
  const report = resolveProviderPreflight({
    config: cfg(),
    registry: registry([], []),
    roles: roles(required("driver", "missing-driver"), required("builder", "missing-builder"), required("critic")),
  });
  assert.equal(report.issues.length, 3);
  assert.deepEqual(report.issues.map((issue) => issue.role), ["driver", "builder", "critic"]);
});

test("CLI JSON is one bounded document and returns the required exit codes", () => {
  const readyDeps = {
    config: cfg(),
    registry: registry([model("driver-model", "provider-a")], [provider("provider-a", READY_INFO)]),
    roles: roles(required("driver", "driver-model")),
  };
  let out = "";
  let err = "";
  const readyCode = runProviderPreflightCli(["--check-providers", "--json"], { ...readyDeps, out: (text) => { out += text; }, err: (text) => { err += text; } });
  assert.equal(readyCode, 0);
  assert.equal(err, "");
  const parsed = JSON.parse(out) as { command: string; status: string; localOnly: boolean; remoteReachability: string; wouldStartPaidInvocation: boolean };
  assert.equal(parsed.command, "doctor.checkProviders");
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.localOnly, true);
  assert.equal(parsed.remoteReachability, "not_checked");
  assert.equal(parsed.wouldStartPaidInvocation, false);

  out = "";
  const blockedCode = runProviderPreflightCli(["--check-providers", "--json"], {
    ...readyDeps,
    registry: registry([], []),
    out: (text) => { out += text; },
  });
  assert.equal(blockedCode, 1);
  assert.equal((JSON.parse(out) as { status: string }).status, "blocked");

  out = "";
  const usageCode = runProviderPreflightCli(["--check-providers", "--fix", "--json"], {
    ...readyDeps,
    out: (text) => { out += text; },
  });
  assert.equal(usageCode, 2);
  assert.equal((JSON.parse(out) as { status: string; issues: readonly { code: string }[] }).issues[0]?.code, "PROVIDER_PREFLIGHT_INTERNAL_ERROR");
});

test("CLI returns exit 2 and a typed internal issue when the resolver fails", () => {
  let out = "";
  const secret = "PREFLIGHT-SECRET-ERROR-VALUE";
  const code = runProviderPreflightCli(["--check-providers", "--json"], {
    config: cfg({ IKBI_DEEPSEEK_API_KEY: secret }),
    env: { IKBI_DEEPSEEK_API_KEY: secret },
    registry: {
      getModel: () => { throw new Error(`synthetic resolver failure: ${secret}`); },
      getProvider: () => undefined,
    },
    roles: roles(required("driver", "driver-model")),
    out: (text) => { out += text; },
  });
  const report = JSON.parse(out) as { status: string; issues: readonly { code: string; message: string }[] };
  assert.equal(code, 2);
  assert.equal(report.status, "error");
  assert.equal(report.issues[0]?.code, "PROVIDER_PREFLIGHT_INTERNAL_ERROR");
  assert.match(report.issues[0]?.message ?? "", /synthetic resolver failure/);
  assert.equal(out.includes(secret), false);
});

test("production role assignments use the same config-resolved driver, builder, critic, and competitive models", () => {
  const productionConfig = cfg({
    IKBI_MODEL_DRIVER: "driver-from-config",
    IKBI_MODEL_BUILDER: "builder-from-config",
    IKBI_MODEL_CRITIC: "critic-from-config",
    IKBI_COMPETITIVE_MODELS: "race-a,race-b",
  });
  const resolved = providerPreflightRoles(productionConfig);
  assert.deepEqual(
    resolved.filter((role) => ["driver", "builder", "critic", "competitive"].includes(role.role)).map((role) => [role.role, role.model]),
    [["driver", "driver-from-config"], ["builder", "builder-from-config"], ["critic", "critic-from-config"], ["competitive", "race-a"], ["competitive", "race-b"]],
  );
});
