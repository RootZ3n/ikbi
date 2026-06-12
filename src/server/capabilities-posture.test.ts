/**
 * PRODUCT TEST — through the live HTTP adapter (`buildServer` → `GET /capabilities`).
 *
 * Phase 1 acceptance: a remote agent discovering ikbi over HTTP must learn the TRUTH about the
 * chat surface — that it is ephemeral, unmanaged, unverified, and has no governed promote — and
 * must not be able to infer golden-path semantics from the tool inventory. This drives the real
 * Fastify route (not the posture function in isolation), so the endpoint wiring is what's proven.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import "../modules/egress/index.js";

import { routes } from "./registry.js";
import { buildServer } from "./index.js";

afterEach(() => routes.reset());

test("GET /capabilities reports the chat surface's lifecycle truth, not golden-path guarantees", async () => {
  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/capabilities" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      lifecycle: Record<string, boolean>;
      chatSessions: { persistence: string; resumable: boolean; warning: string };
      surfaces: Array<{ surface: string; classification: string }>;
      safetyPosture: { posture: string };
    };

    // The HTTP /chat coding loop's honest lifecycle: every golden-path guarantee is ABSENT.
    assert.equal(body.lifecycle.persistentSessions, false, "http sessions are ephemeral");
    assert.equal(body.lifecycle.managedWorkspace, false);
    assert.equal(body.lifecycle.rollbackDurability, false);
    assert.equal(body.lifecycle.verificationPath, false);
    assert.equal(body.lifecycle.promoteApplyPath, false);

    // The ephemeral disclosure is present and points at the durable alternative.
    assert.equal(body.chatSessions.persistence, "ephemeral");
    assert.equal(body.chatSessions.resumable, false);
    assert.match(body.chatSessions.warning, /do not survive server restart/);

    // The surface classifications are exposed for discovery.
    const chat = body.surfaces.find((s) => s.surface === "http /chat");
    assert.equal(chat?.classification, "experimental", "http /chat is disclosed as experimental");
    const build = body.surfaces.find((s) => s.surface === "build (CLI)");
    assert.equal(build?.classification, "core");

    // Safety posture is reported (hardened by default in the test env).
    assert.equal(typeof body.safetyPosture.posture, "string");
  } finally {
    await app.close();
  }
});
