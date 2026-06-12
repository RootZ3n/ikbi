import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveLogLevel } from "./log.js";

test("interactive TTY defaults structured logging to silent unless explicitly configured", () => {
  assert.equal(resolveLogLevel({}, true), "silent");
  assert.equal(resolveLogLevel({ IKBI_LOG_LEVEL: "debug" }, true), "debug");
  assert.equal(resolveLogLevel({ IKBI_LOG_LEVEL: "info" }, false), "info");
});
