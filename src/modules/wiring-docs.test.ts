/**
 * Wiring/doc regression guards (audit Fix 4 + Fix 5).
 *
 * The Codex audit found documentation drift: module comments and MODULE_CENSUS.md
 * lagged the actual wiring (chat's /chat route, the registered CLI commands, the
 * cognition default router). These tests pin the corrected statements so the stale
 * claims cannot silently reappear, and assert the dormant modules carry their explicit
 * `@status` labels.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const here = new URL(".", import.meta.url).pathname; // src/modules/
const repoRoot = new URL("../../", import.meta.url).pathname;
const read = (rel: string) => readFileSync(`${here}${rel}`, "utf8");

// ── Fix 4: stale comments removed / corrected ────────────────────────────────

test("the modules barrel no longer claims modules register nothing yet", () => {
  const src = read("index.ts");
  assert.ok(!/none do so yet/.test(src), 'the stale "none do so yet" claim must be gone');
  // It now names the real registrations.
  assert.match(src, /register CLI commands/);
  assert.match(src, /POST \/chat/);
});

test("cognition-layer index reflects its direct CLI wiring (not 'no barrel entry / dormant')", () => {
  const src = read("cognition-layer/index.ts");
  assert.ok(!/needs no modules-barrel entry/.test(src), "stale 'needs no barrel entry' claim removed");
  assert.match(src, /default router/i);
  assert.match(src, /live entrypoint, not dormant/);
});

test("MODULE_CENSUS.md reflects the chat route and the mcp command", () => {
  const census = readFileSync(`${repoRoot}MODULE_CENSUS.md`, "utf8");
  assert.match(census, /POST \/chat/, "census documents the chat route");
  assert.match(census, /ikbi mcp/, "census documents the mcp command");
  assert.ok(!/none do yet/.test(census), "stale 'registry is empty / none do yet' claim removed");
});

// ── Fix 5: dormant modules carry an explicit @status label ───────────────────

test("dormant library-only modules are labeled @status in their index", () => {
  for (const mod of ["dependency-install", "subagent-spawning", "self-observation"]) {
    const src = read(`${mod}/index.ts`);
    assert.match(src, /@status dormant \(library-only\)/, `${mod} carries the dormant @status label`);
  }
});

test("mcp-model-loop is labeled partially-wired (stdio is CLI-reachable, mock is library)", () => {
  const src = read("mcp-model-loop/index.ts");
  assert.match(src, /@status partially-wired/);
  assert.match(src, /ikbi mcp/, "notes the live CLI path");
});

test("subagent-spawning's label records the deliberate separation from delegate_task", () => {
  const src = read("subagent-spawning/index.ts");
  assert.match(src, /SEPARATE from the builder's `delegate_task`|deliberately not merged/);
});
