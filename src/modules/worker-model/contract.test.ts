import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTRACT_VERSIONS, checkCompatibility } from "../../core/contracts/index.js";
import {
  CONTRACT_VERSION,
  isWorkerRole,
  toOutcomeStatus,
  WORKER_ROLES,
  type WorkerOutcome,
} from "./contract.js";

test("the worker-model contract is versioned (1.0.0, the initial module contract)", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
});

test("WorkerRole enum is the complete five-role set, in dispatch order", () => {
  assert.deepEqual([...WORKER_ROLES], ["scout", "builder", "verifier", "critic", "integrator"]);
  assert.equal(WORKER_ROLES.length, 5);
  for (const r of WORKER_ROLES) assert.equal(isWorkerRole(r), true);
  assert.equal(isWorkerRole("orchestrator"), false);
  assert.equal(isWorkerRole(""), false);
});

test("toOutcomeStatus maps stub→partial and passes the four real statuses through", () => {
  assert.equal(toOutcomeStatus("stub"), "partial");
  for (const s of ["success", "failure", "partial", "rejected"] as WorkerOutcome[]) {
    assert.equal(toOutcomeStatus(s), s);
  }
});

test("all EIGHT frozen-contract pins are present and match the version table", () => {
  // These are the exact targets index.ts asserts at load. Each must be compatible
  // with the present frozen version (the version table = CONTRACT_VERSIONS).
  const pins: Array<[Parameters<typeof checkCompatibility>[0], string]> = [
    ["provider", "1.3.0"],
    ["injection", "1.0.0"],
    ["identity", "1.1.0"],
    ["trust", "1.0.0"],
    ["workspace", "1.0.0"],
    ["events", "1.0.0"],
    ["receipt", "1.0.0"],
    ["substrate", "1.0.0"],
  ];
  assert.equal(pins.length, 8);
  for (const [name, target] of pins) {
    assert.equal(checkCompatibility(name, target).compatible, true, `${name}@${target} must be compatible`);
    assert.equal(target, CONTRACT_VERSIONS[name], `${name} pin must match the present version table`);
  }
});

test("importing the module entrypoint runs all eight pins without throwing", async () => {
  await assert.doesNotReject(async () => {
    await import("./index.js");
  });
});
