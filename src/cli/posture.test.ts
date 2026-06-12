/**
 * PRODUCT POSTURE — the single shared status object, and the operator-facing surfaces that read it.
 *
 * Phase 1 acceptance: doctor and the CLI `capabilities` report must tell the TRUTH about which
 * surfaces are core vs experimental/dormant and which lifecycle guarantees each editing surface
 * actually provides. These tests drive the real adapters (`runDoctor`, `runCapabilities`,
 * `postureLines`) — not a mock — so an overstatement is caught here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// EGRESS FIRST — posture pulls in the builder/chat tool arrays via runCapabilities, which transit
// the provider singleton; the provider resolves the egress fetch guard at construction.
import "../modules/egress/index.js";

import { runDoctor } from "./doctor.js";
import { postureLines, productPosture } from "./posture.js";

test("productPosture classifies the parallel paths exactly as PRODUCT-SPINE does", () => {
  const p = productPosture({ env: {} });
  const bySurface = new Map(p.classifications.map((c) => [c.surface, c.classification]));
  assert.equal(bySurface.get("build (CLI)"), "core", "the build path is the golden/core surface");
  assert.equal(bySurface.get("repl chat"), "experimental", "repl chat is a dangerous parallel path");
  assert.equal(bySurface.get("http /chat"), "experimental", "http /chat is a dangerous parallel path");
  assert.equal(bySurface.get("mcp loop"), "experimental");
  assert.equal(bySurface.get("batch"), "experimental");
  assert.equal(bySurface.get("bare-goal cognition"), "experimental");
  assert.equal(bySurface.get("sub-agent spawn"), "dormant", "sub-agent spawn has no default operator path");
});

test("productPosture lifecycle: build is full; repl chat is managed + verified; http is ephemeral", () => {
  const p = productPosture({ env: {} });
  // The golden path provides the full lifecycle.
  assert.deepEqual(p.lifecycle.build, {
    persistentSessions: true,
    managedWorkspace: true,
    rollbackDurability: true,
    verificationPath: true,
    promoteApplyPath: true,
  });
  // REPL chat (Phase 3): repo mode is managed + promotable AND verified — /apply runs the ladder.
  assert.equal(p.lifecycle.replChat.persistentSessions, true, "repl sessions are disk-resumable");
  assert.equal(p.lifecycle.replChat.managedWorkspace, true, "repo-mode repl uses a managed workspace");
  assert.equal(p.lifecycle.replChat.rollbackDurability, true, "edits stay in the workspace until /apply; /discard is safe");
  assert.equal(p.lifecycle.replChat.promoteApplyPath, true, "explicit /apply runs a governed promote");
  assert.equal(p.lifecycle.replChat.verificationPath, true, "Phase 3: managed /apply runs ladder verification before promote");
  // HTTP chat: ephemeral + non-managed (deliberately deferred).
  assert.equal(p.lifecycle.httpChat.persistentSessions, false, "http sessions are ephemeral");
  assert.equal(p.lifecycle.httpChat.managedWorkspace, false, "http chat stays non-managed");
  assert.equal(p.lifecycle.httpChat.promoteApplyPath, false);
  assert.equal(p.chatSessions.persistence, "ephemeral");
  assert.equal(p.chatSessions.resumable, false);
});

test("productPosture safety reflects the production-resolved modes (hardened by default, env can opt out)", () => {
  const hardened = productPosture({ env: {} });
  assert.equal(hardened.safety.verification, "ladder");
  assert.equal(hardened.safety.retrieval, "index");
  assert.equal(hardened.safety.posture, "HARDENED");
  const legacy = productPosture({ env: { IKBI_VERIFY: "legacy", IKBI_RETRIEVAL: "legacy" } });
  assert.equal(legacy.safety.posture, "LEGACY");
});

test("postureLines disclose classification AND lifecycle truth in plain text", () => {
  const text = postureLines(productPosture({ env: {} })).join("\n");
  assert.match(text, /repl chat\s+EXPERIMENTAL/);
  assert.match(text, /sub-agent spawn\s+DORMANT/);
  assert.match(text, /build \(CLI\)\s+CORE/);
  // The lifecycle table must show the chat gaps as ✗ and the http ephemerality note.
  assert.match(text, /http \/chat.*✗ managed-workspace/);
  assert.match(text, /http \/chat.*✗ verification/);
  assert.match(text, /EPHEMERAL/);
});

test("runDoctor (the live adapter) surfaces the PRODUCT SURFACES section with lifecycle truth", () => {
  const text = runDoctor().lines.join("\n");
  assert.match(text, /PRODUCT SURFACES/);
  assert.match(text, /repl chat\s+EXPERIMENTAL/);
  assert.match(text, /sub-agent spawn\s+DORMANT/);
  assert.match(text, /http \/chat.*✗ promote\/apply/);
  // Phase 3: repl repo mode is managed + verified + promotable — doctor must reflect all three.
  assert.match(text, /repl chat.*✓ managed-workspace.*✓ verification.*✓ promote\/apply/);
  // http /chat remains non-managed / non-verified / non-promotable.
  assert.match(text, /http \/chat.*✗ verification/);
});
