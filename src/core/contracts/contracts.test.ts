import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertContractCompatible,
  checkCompatibility,
  CONTRACT_NAMES,
  CONTRACT_VERSIONS,
  ContractVersionError,
  contractVersion,
  isCompatible,
} from "./index.js";

test("the registry lists all 8 frozen contracts with versions", () => {
  assert.equal(CONTRACT_NAMES.length, 8);
  for (const name of CONTRACT_NAMES) {
    assert.match(CONTRACT_VERSIONS[name], /^\d+\.\d+\.\d+$/, `${name} has a semver`);
    assert.equal(contractVersion(name), CONTRACT_VERSIONS[name]);
  }
  assert.deepEqual(
    [...CONTRACT_NAMES].sort(),
    ["events", "identity", "injection", "provider", "receipt", "substrate", "trust", "workspace"],
  );
  // Frozen-core contracts at their additive-bumped versions:
  //  - identity 1.1.0 — the `OperationContext.dryRun` seam (Step S).
  //  - provider 1.1.0 — the fetch-guard seam (Step F).
  // Both are additive-MINOR per the codified rule; the rest remain 1.0.0.
  const expected: Record<string, string> = {
    provider: "1.1.0",
    injection: "1.0.0",
    identity: "1.1.0",
    substrate: "1.0.0",
    receipt: "1.0.0",
    trust: "1.0.0",
    events: "1.0.0",
    workspace: "1.0.0",
  };
  for (const name of CONTRACT_NAMES) assert.equal(CONTRACT_VERSIONS[name], expected[name]);
});

test("the registry is sourced from the contracts themselves (single source of truth)", async () => {
  const { CONTRACT_VERSION } = await import("../provider/contract.js");
  const { WORKSPACE_CONTRACT_VERSION } = await import("../workspace/contract.js");
  assert.equal(CONTRACT_VERSIONS.provider, CONTRACT_VERSION);
  assert.equal(CONTRACT_VERSIONS.workspace, WORKSPACE_CONTRACT_VERSION);
});

test("isCompatible: same major + present >= target is compatible (additive minor/patch)", () => {
  assert.equal(isCompatible("1.0.0", "1.0.0"), true);
  assert.equal(isCompatible("1.0.0", "1.2.0"), true, "present has additive fields the module ignores");
  assert.equal(isCompatible("1.2.3", "1.2.5"), true);
  assert.equal(isCompatible("1.2.0", "1.10.0"), true);
});

test("isCompatible: a different major, or a present OLDER than target, is incompatible", () => {
  assert.equal(isCompatible("1.0.0", "2.0.0"), false, "breaking major bump");
  assert.equal(isCompatible("2.0.0", "1.0.0"), false, "major differs");
  assert.equal(isCompatible("1.2.0", "1.0.0"), false, "present lacks the targeted additive field");
  assert.equal(isCompatible("1.0.5", "1.0.2"), false, "present patch is behind");
});

test("assertContractCompatible passes for a compatible version", () => {
  assert.doesNotThrow(() => assertContractCompatible("provider", "1.0.0"));
  assert.doesNotThrow(() => assertContractCompatible("workspace", "1.0.0"));
});

test("assertContractCompatible throws a clear typed error on mismatch", () => {
  assert.throws(
    () => assertContractCompatible("trust", "2.0.0"),
    (e: unknown) => {
      if (!(e instanceof ContractVersionError)) return false;
      assert.equal(e.contract, "trust");
      assert.equal(e.expected, "2.0.0");
      assert.equal(e.actual, "1.0.0");
      assert.match(e.message, /major version differs/);
      return true;
    },
  );
  // A module targeting a newer-than-present version is also caught.
  assert.throws(() => assertContractCompatible("events", "1.5.0"), ContractVersionError);
});

test("checkCompatibility reports a non-throwing verdict + reason", () => {
  // A module pinning identity@1.0.0 stays compatible with the present 1.1.0 (the
  // additive dryRun seam) — the codified additive-minor rule, demonstrated.
  assert.deepEqual(checkCompatibility("identity", "1.0.0"), {
    contract: "identity",
    target: "1.0.0",
    present: "1.1.0",
    compatible: true,
    reason: "compatible (same major; present >= target)",
  });
  const bad = checkCompatibility("receipt", "2.0.0");
  assert.equal(bad.compatible, false);
  assert.match(bad.reason, /major version differs/);
  const malformed = checkCompatibility("events", "not-a-version");
  assert.equal(malformed.compatible, false);
});
