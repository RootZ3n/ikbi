import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { trust } from "../core/trust/index.js";
import { registerRoutes, routes } from "./registry.js";
import { buildServer, startServer } from "./index.js";

afterEach(() => routes.reset());

// M5: startServer must warm the trust tier cache BEFORE accepting connections, or early
// requests fail closed (downgraded to the trust floor) until the background load finishes.
// We make preload throw a sentinel: if startServer REJECTS with it and never binds a port,
// then preload was both CALLED and AWAITED before app.listen — exactly the ordering we want.
test("M5: startServer awaits trust.preload() before binding the port", async () => {
  const orig = trust.preload;
  const order: string[] = [];
  (trust as { preload: () => Promise<unknown> }).preload = async () => {
    order.push("preload");
    throw new Error("PRELOAD_SENTINEL");
  };
  try {
    await assert.rejects(() => startServer(), /PRELOAD_SENTINEL/, "the preload rejection propagated — it was awaited before listen");
    assert.deepEqual(order, ["preload"], "preload ran (and, having thrown, the server never bound a port)");
  } finally {
    (trust as { preload: typeof orig }).preload = orig;
  }
});

test("a module registers a route and the server serves it WITHOUT editing server/index.ts", async () => {
  // This is the sample module — it touches only the registrar seam.
  registerRoutes("sample", async (app) => {
    app.get("/sample/ping", async () => ({ pong: true, module: "sample" }));
  });

  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/sample/ping" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { pong: true, module: "sample" });

    // The core routes still work (the seam is additive).
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("each registrar gets its own encapsulation context (a prefix stays isolated)", async () => {
  registerRoutes("a", async (app) => {
    app.register(
      async (scoped) => {
        scoped.get("/thing", async () => ({ from: "a" }));
      },
      { prefix: "/a" },
    );
  });
  registerRoutes("b", async (app) => {
    app.get("/b/thing", async () => ({ from: "b" }));
  });

  const app = buildServer();
  await app.ready();
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/a/thing" })).json(), { from: "a" });
    assert.deepEqual((await app.inject({ method: "GET", url: "/b/thing" })).json(), { from: "b" });
  } finally {
    await app.close();
  }
});

test("duplicate module registration is rejected (a wiring bug, not silent)", () => {
  registerRoutes("dup", () => {});
  assert.throws(() => registerRoutes("dup", () => {}), /already registered/);
});

test("the registry tracks module names and registration order", () => {
  registerRoutes("one", () => {});
  registerRoutes("two", () => {});
  assert.deepEqual(routes.modules(), ["one", "two"]);
  assert.deepEqual(
    routes.all().map((e) => e.module),
    ["one", "two"],
  );
});

test("server error handler returns a generic 500 body", async () => {
  registerRoutes("boom", async (app) => {
    app.get("/boom", async () => {
      throw new Error("secret stack detail");
    });
  });

  const app = buildServer();
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: "internal server error" });
    assert.equal(res.body.includes("secret stack detail"), false);
  } finally {
    await app.close();
  }
});
