import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createVelum } from "../src/adapters/generic.js";
import { velumExpress } from "../src/adapters/express.js";
import { velumFastify } from "../src/adapters/fastify.js";
import { clearAllCredentials } from "../src/core/credential-buffer.js";

beforeEach(() => clearAllCredentials());

const AWS_KEY = "AKIA" + "Z".repeat(16);
const OAI_KEY = "sk-" + "A".repeat(48);

// ── Generic adapter ───────────────────────────────────────────────────────────

test("generic: createVelum exposes the full bound API", () => {
  const v = createVelum();
  assert.equal(typeof v.classify, "function");
  assert.equal(typeof v.scanContext, "function");
  assert.equal(typeof v.applyOutputGuard, "function");
  assert.equal(typeof v.scanPii, "function");
  assert.equal(typeof v.maskPii, "function");
  assert.equal(typeof v.getCredential, "function");
  assert.equal(typeof v.getAvailableCredentials, "function");
});

test("generic: classify redacts and buffers, getCredential consumes once", () => {
  const v = createVelum();
  const r = v.classify(`use ${AWS_KEY}`);
  assert.equal(r.classification, "CREDENTIAL");
  const id = r.credentialBufferIds[0]!;
  assert.equal(v.getCredential(id), AWS_KEY);
  assert.equal(v.getCredential(id), null);
});

test("generic: output guard blocks secret leakage", () => {
  const v = createVelum();
  const out = v.applyOutputGuard(`key is ${AWS_KEY}`, { inCharacter: false });
  assert.equal(out.blocked, true);
  assert.ok(!out.text.includes(AWS_KEY));
});

test("generic: disabled config passes everything through", () => {
  const v = createVelum({ enabled: false });
  const r = v.classify(`use ${AWS_KEY}`);
  assert.equal(r.classification, "SAFE");
  assert.equal(r.sanitizedMessage, `use ${AWS_KEY}`);
  const out = v.applyOutputGuard(`leak ${AWS_KEY}`);
  assert.equal(out.blocked, false);
  assert.ok(out.text.includes(AWS_KEY));
});

test("generic: respects custom neverRedact terms", () => {
  const v = createVelum({ neverRedact: ["acmecorp"] });
  const r = v.classify("secret_key=acmecorpacmecorpacmecorpacmecorpacmecorp");
  assert.equal(r.classification, "SAFE");
});

test("generic: processPii uses the configured default level", () => {
  const v = createVelum({ defaultPiiLevel: 2 });
  const r = v.processPii("email a@b.com");
  assert.equal(r.level, 2);
  assert.equal(r.masked, true);
});

// ── Express adapter ───────────────────────────────────────────────────────────

function mockExpress(body: Record<string, unknown>) {
  const req: Record<string, unknown> = { body };
  const responses: { json?: unknown; send?: unknown } = {};
  const res: Record<string, unknown> = {
    json: (b: unknown) => ((responses.json = b), b),
    send: (b: unknown) => ((responses.send = b), b),
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, responses, next, wasNexted: () => nextCalled };
}

test("express: redacts credential in body and sets req.velum", () => {
  const mw = velumExpress({});
  const { req, next, wasNexted } = mockExpress({ message: `connect using ${OAI_KEY}` });
  mw(req as never, {} as never, next);
  assert.ok(wasNexted());
  assert.ok((req as { velum?: unknown }).velum);
  assert.ok(!(req.body as { message: string }).message.includes(OAI_KEY));
  assert.match((req.body as { message: string }).message, /\[REDACTED-CREDENTIAL\]/);
});

test("express: wraps res.json to block secret leakage", () => {
  const mw = velumExpress({});
  const { req, res, next } = mockExpress({ message: "hello" });
  mw(req as never, res as never, next);
  const out = (res.json as (b: unknown) => { text: string })({ text: `here: ${AWS_KEY}` });
  assert.ok(!out.text.includes(AWS_KEY));
  assert.match(out.text, /blocked by policy/);
});

test("express: redacts secrets in context messages array", () => {
  const mw = velumExpress({});
  const { req, next } = mockExpress({ messages: [{ role: "tool", content: `found ${AWS_KEY}` }] });
  mw(req as never, {} as never, next);
  const messages = (req.body as { messages: Array<{ content: string }> }).messages;
  assert.ok(!messages[0]!.content.includes(AWS_KEY));
});

// ── Fastify adapter ───────────────────────────────────────────────────────────

function mockFastify() {
  const hooks: Record<string, Array<(...args: unknown[]) => void>> = {};
  const fastify = {
    decorateRequest: () => {},
    addHook: (name: string, fn: (...args: unknown[]) => void) => {
      (hooks[name] = hooks[name] ?? []).push(fn);
    },
  };
  return { fastify, hooks };
}

test("fastify: hooks classify input and guard output", () => {
  const { fastify, hooks } = mockFastify();
  velumFastify(fastify as never, {});

  const req: Record<string, unknown> = { body: { message: `key ${OAI_KEY}` } };

  // onRequest decorates the request.
  hooks["onRequest"]![0]!(req, {}, () => {});
  assert.ok((req as { velum?: unknown }).velum);

  // preHandler classifies + redacts.
  hooks["preHandler"]![0]!(req, {}, () => {});
  assert.match((req.body as { message: string }).message, /\[REDACTED-CREDENTIAL\]/);

  // onSend guards the serialized payload.
  let out: unknown;
  const payload = JSON.stringify({ text: `here ${AWS_KEY}` });
  hooks["onSend"]![0]!(req, {}, payload, (_err: unknown, p: unknown) => {
    out = p;
  });
  assert.ok(typeof out === "string");
  assert.ok(!(out as string).includes(AWS_KEY));
});

test("fastify: disabled config leaves payload untouched", () => {
  const { fastify, hooks } = mockFastify();
  velumFastify(fastify as never, { enabled: false });
  const req: Record<string, unknown> = { body: { message: `key ${OAI_KEY}` } };
  hooks["onRequest"]![0]!(req, {}, () => {});
  hooks["preHandler"]![0]!(req, {}, () => {});
  assert.ok((req.body as { message: string }).message.includes(OAI_KEY));
});
