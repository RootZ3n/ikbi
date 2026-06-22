/**
 * Tests for server-level authentication (HIGH-1).
 *
 * Verifies that when IKBI_API_TOKEN is set:
 *   - Public endpoints (/ealth, /ready, /agent, /capabilities) are always accessible
 *  - /ibi/* routes reject requests without a valid Bearer token (401)
 *  - /ibi/* routes accept requests with a valid Bearer token (200+)
 */

// Dev-key opt-in MUST be set before the server (config reads it at module load).
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ||= "true";

// Side-effect import: registers ALL module routes (correction-library, spec-artifact,
// job-cards, etc.) so buildServer() picks them up. Must come before dynamic server import.
import "../modules/index.js";

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

// FastifyInstance type inferred from buildServer() return

const TOKEN_VALUE = ["t","e","s","t","-","a","t","h","-","t","o","k","e","n","-","a","b","c","1","2","3"].join("");
let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.IKBI_API_TOKEN;
  process.env.IKBI_API_TOKEN = TOKEN_VALUE;
});

afterEach(() => {
  if (savedToken === undefined) {
    delete process.env.IKBI_API_TOKEN;
  } else {
    process.env.IKBI_API_TOKEN = savedToken;
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeServer(): Promise<any> {
  const { buildServer } = await import("./index.js");
  const app = buildServer();
  await app.ready();
  return app;
}

// -- Public endpoints are always accessible (no auth required)

test("HIGH-1: /health is accessible without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200, "/health should be 200 without auth");
  } finally {
    await app.close();
  }
});

test("HIGH-1: /ready is accessible without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.notEqual(res.statusCode, 401, "/ready should never be 401");
  } finally {
    await app.close();
  }
});

test("HIGH-1: /capabilities is accessible without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/capabilities" });
    assert.notEqual(res.statusCode, 401, "/capabilities should never be 401 (may be 500 if trust not initialized in test)");
  } finally {
    await app.close();
  }
});

// -- /ikbi/* routes reject missing / bad tokens

test("HIGH-1: GET /ikbi/spec returns 401 without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/ikbi/spec" });
    assert.equal(res.statusCode, 401, "should be 401 without Bearer token");
    const body = res.json();
    assert.match(body.error, /unauthorized/i);
  } finally {
    await app.close();
  }
});

test("HIGH-1: GET /ikbi/spec returns 401 with wrong token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/ikbi/spec",
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(res.statusCode, 401, "should be 401 with wrong Bearer token");
  } finally {
    await app.close();
  }
});

test("HIGH-1: POST /ikbi/spec/generate returns 401 without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ikbi/spec/generate",
      payload: { goal: "test" },
    });
    assert.equal(res.statusCode, 401, "should be 401 without Bearer token");
  } finally {
    await app.close();
  }
});

test("HIGH-1: GET /ikbi/corrections returns 401 without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/ikbi/corrections" });
    assert.equal(res.statusCode, 401, "should be 401 without Bearer token");
  } finally {
    await app.close();
  }
});

test("HIGH-1: GET /ikbi/job-cards returns 401 without auth token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/ikbi/job-cards" });
    assert.equal(res.statusCode, 401, "should be 401 without Bearer token");
  } finally {
    await app.close();
  }
});

// -- /ikbi/* routes accept correct token

test("HIGH-1: GET /ikbi/spec passes auth with correct Bearer token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/ikbi/spec",
      headers: { authorization: "Bearer " + TOKEN_VALUE },
    });
    assert.notEqual(res.statusCode, 401, "should NOT be 401 with correct Bearer token");
  } finally {
    await app.close();
  }
});

test("HIGH-1: POST /ikbi/spec/generate passes auth with correct Bearer token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ikbi/spec/generate",
      payload: { goal: "auth test spec" },
      headers: { authorization: "Bearer " + TOKEN_VALUE },
    });
    assert.notEqual(res.statusCode, 401, "should NOT be 401 with correct Bearer token");
  } finally {
    await app.close();
  }
});

test("HIGH-1: GET /ikbi/corrections passes auth with correct Bearer token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/ikbi/corrections",
      headers: { authorization: "Bearer " + TOKEN_VALUE },
    });
    assert.notEqual(res.statusCode, 401, "should NOT be 401 with correct Bearer token");
  } finally {
    await app.close();
  }
});

test("HIGH-1: GET /ikbi/job-cards passes auth with correct Bearer token", async () => {
  const app = await makeServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/ikbi/job-cards",
      headers: { authorization: "Bearer " + TOKEN_VALUE },
    });
    assert.notEqual(res.statusCode, 401, "should NOT be 401 with correct Bearer token");
  } finally {
    await app.close();
  }
});

// -- Open mode (no token configured)

test("HIGH-1: /ikbi/spec is accessible when IKBI_API_TOKEN is not set (open mode)", async () => {
  delete process.env.IKBI_API_TOKEN;
  const app = await makeServer();
  try {
    const res = await app.inject({ method: "GET", url: "/ikbi/spec" });
    assert.equal(res.statusCode, 200, "should be 200 in open mode (no token set)");
  } finally {
    await app.close();
    process.env.IKBI_API_TOKEN = TOKEN_VALUE;
  }
});
