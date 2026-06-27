import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  scanPii,
  maskPii,
  demask,
  sanitizePii,
  processWithPii,
  getDetectionLog,
  clearDetectionLog,
} from "../src/core/pii.js";

beforeEach(() => clearDetectionLog());

// ── Detection by type ─────────────────────────────────────────────────────────

test("detects EMAIL", () => {
  const d = scanPii("reach me at jane.doe@example.com please");
  assert.ok(d.some((x) => x.type === "EMAIL" && x.value === "jane.doe@example.com"));
});

test("detects PHONE", () => {
  const d = scanPii("call 555-123-4567 today");
  assert.ok(d.some((x) => x.type === "PHONE"));
});

test("detects SSN", () => {
  const d = scanPii("ssn 123-45-6789 on file");
  assert.ok(d.some((x) => x.type === "SSN"));
});

test("detects CREDIT_CARD", () => {
  const d = scanPii("card 4111 1111 1111 1111 expires soon");
  assert.ok(d.some((x) => x.type === "CREDIT_CARD"));
});

test("detects IP_ADDRESS", () => {
  const d = scanPii("server at 192.168.1.100 is down");
  assert.ok(d.some((x) => x.type === "IP_ADDRESS" && x.value === "192.168.1.100"));
});

test("NAME detection is opt-in (disabled by default)", () => {
  const d = scanPii("the engineer John Smith approved it");
  assert.ok(!d.some((x) => x.type === "NAME"), "NAME not detected by default");
});

test("detects NAME when detectNames enabled", () => {
  const d = scanPii("the engineer John Smith approved it", undefined as never, { detectNames: true });
  assert.ok(d.some((x) => x.type === "NAME" && x.value === "John Smith"));
});

test("clean text yields no detections", () => {
  assert.deepEqual(scanPii("the build finished without issues"), []);
});

// ── Mask / unmask roundtrip ──────────────────────────────────────────────────

test("maskPii + demask is a lossless roundtrip", () => {
  const text = "email jane.doe@example.com or call 555-123-4567 for help";
  const { text: masked, placeholderMap } = maskPii(text);
  assert.ok(!masked.includes("jane.doe@example.com"));
  assert.ok(!masked.includes("555-123-4567"));
  assert.match(masked, /\[EMAIL_1\]/);
  assert.equal(demask(masked, placeholderMap), text);
});

test("identical values reuse the same placeholder", () => {
  const { text: masked, placeholderMap } = maskPii("a@b.com and again a@b.com");
  const occurrences = masked.split("[EMAIL_1]").length - 1;
  assert.equal(occurrences, 2);
  assert.equal(placeholderMap.size, 1);
});

// ── Levels ────────────────────────────────────────────────────────────────────

test("level 1 observes only (no masking)", () => {
  const r = processWithPii("email jane.doe@example.com", 1);
  assert.equal(r.masked, false);
  assert.equal(r.maskedText, undefined);
  assert.ok(r.detections.some((d) => d.type === "EMAIL" && d.count === 1));
});

test("level 2 redacts with reversible placeholders", () => {
  const r = processWithPii("email jane.doe@example.com", 2);
  assert.equal(r.masked, true);
  assert.match(r.maskedText!, /\[EMAIL_1\]/);
  assert.ok(r.placeholderMap instanceof Map);
  assert.equal(demask(r.maskedText!, r.placeholderMap!), "email jane.doe@example.com");
});

test("level 3 sanitizes to [REDACTED] with no map", () => {
  const r = processWithPii("email jane.doe@example.com", 3);
  assert.equal(r.masked, true);
  assert.ok(r.maskedText!.includes("[REDACTED]"));
  assert.ok(!r.maskedText!.includes("jane.doe@example.com"));
  assert.equal(r.placeholderMap, undefined);
});

test("sanitizePii strips all PII", () => {
  const out = sanitizePii("john@a.com at 10.0.0.1");
  assert.ok(!out.includes("john@a.com"));
  assert.ok(!out.includes("10.0.0.1"));
  assert.ok(out.includes("[REDACTED]"));
});

// ── Detection log capping ─────────────────────────────────────────────────────

test("detection log caps at 500 entries", () => {
  for (let i = 0; i < 600; i++) processWithPii("email jane.doe@example.com", 1);
  assert.equal(getDetectionLog().length, 500);
});

test("detection log records type+count only, never raw values", () => {
  processWithPii("email jane.doe@example.com", 2);
  const log = getDetectionLog();
  assert.ok(!JSON.stringify(log).includes("jane.doe@example.com"));
});
