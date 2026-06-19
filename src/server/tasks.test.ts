import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import type { WorkerResult, WorkerTask } from "../modules/worker-model/index.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import { TaskService, type TaskServiceDeps } from "./task-service.js";
import { registerTaskRoutes } from "./tasks.js";

// An existing directory to pass the repo-exists validation.
const REPO = mkdtempSync(join(tmpdir(), "ikbi-task-repo-"));

/** A WorkerResult fixture for a fully successful build. */
function successResult(taskId: string): WorkerResult {
  return {
    contractVersion: "1.0.0",
    taskId,
    outcome: "success",
    promoted: true,
    costUsd: 0.15,
    roles: [
      { role: "scout", outcome: "success", detail: { costUsd: 0.006 } },
      { role: "builder", outcome: "success", detail: { costUsd: 0.1, filesWritten: ["src/auth.ts", "src/auth.test.ts"] } },
      { role: "verifier", outcome: "success", detail: { costUsd: 0.02 } },
      { role: "critic", outcome: "success", detail: { costUsd: 0.01 } },
      { role: "integrator", outcome: "success", detail: { costUsd: 0.014 } },
    ],
  };
}

/** Build a service with injected fakes (no model key / worktree / real identity needed). */
// A fake event bus that does nothing — prevents ensureSubscribed from crashing.
const noopEvents = {
  publish: (input: any) => ({ ...input, id: "noop", timestamp: new Date().toISOString() }),
  subscribe: () => ({ unsubscribe: () => {} }),
  flush: () => Promise.resolve(),
};

function fakeService(over: Partial<TaskServiceDeps> = {}): TaskService {
  // resolveIdentity returns a stub ValidatedIdentity so the real beginOperation runs without a token roster.
  const resolveIdentity = (): ValidatedIdentity => ({ identity: { agentId: "op" } }) as unknown as ValidatedIdentity;
  return new TaskService({
    operatorToken: "operator-token-test",
    workerToken: "worker-token-test",
    resolveIdentity,
    events: noopEvents as any,
    ...over,
  });
}

/** Mount the task routes on a fresh app bound to `service`. */
async function makeApp(service: TaskService): Promise<FastifyInstance> {
  const app = Fastify();
  registerTaskRoutes(app, service);
  await app.ready();
  return app;
}

/** Poll until `cond()` or a bounded number of microtask turns elapse. */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  delete process.env.IKBI_API_TOKEN;
});
afterEach(() => {
  delete process.env.IKBI_API_TOKEN;
});

test("POST /api/build with a valid request → 202 + taskId", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) }); // never resolves: stays running
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "Fix the login bug", repo: REPO } });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.match(body.taskId, /^build-\d+$/);
    assert.equal(body.status, "accepted");
    assert.equal(body.message, "Build task accepted");
  } finally {
    await app.close();
  }
});

test("POST /api/build with a missing repo → 400", async () => {
  const service = fakeService();
  const app = await makeApp(service);
  try {
    // Missing `repo` key → schema rejects (400). A non-existent repo path also → 400.
    const noKey = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "do a thing" } });
    assert.equal(noKey.statusCode, 400);
    const bad = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "do a thing", repo: "/no/such/dir/ikbi-xyz" } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /does not exist/);
  } finally {
    await app.close();
  }
});

test("POST /api/build with an empty goal → 400", async () => {
  const service = fakeService();
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "", repo: REPO } });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /api/fix with a valid request → 202 + taskId", async () => {
  const service = fakeService({ runFix: () => new Promise(() => {}) });
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/fix", payload: { repo: REPO, check: "pnpm test", goal: "Fix failing tests", allowTestEdits: false } });
    assert.equal(res.statusCode, 202);
    assert.match(res.json().taskId, /^fix-\d+$/);
    assert.equal(res.json().message, "Fix task accepted");
  } finally {
    await app.close();
  }
});

test("GET /api/tasks/:taskId for a running task → 200 + running status", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.taskId, taskId);
    assert.equal(body.status, "running");
    assert.equal(body.repo, REPO);
    assert.equal(body.finishedAt, undefined);
  } finally {
    await app.close();
  }
});

test("GET /api/tasks/:taskId for a completed build → 200 + full result", async () => {
  let id = "";
  const service = fakeService({ runBuild: (t: WorkerTask) => { id = t.taskId; return Promise.resolve(successResult(t.taskId)); } });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    await waitFor(() => service.registry.get(taskId)?.status !== "running");
    const body = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
    assert.equal(id, taskId);
    assert.equal(body.status, "success");
    assert.equal(body.totalCost, 0.15);
    assert.equal(body.verificationResult, "pass");
    assert.deepEqual(body.filesChanged, ["src/auth.ts", "src/auth.test.ts"]);
    assert.equal(body.roles.length, 5);
    assert.equal(body.roles[0].role, "scout");
    assert.ok(typeof body.finishedAt === "string");
  } finally {
    await app.close();
  }
});

test("a failing build finalizes as a failure with a reason", async () => {
  const failing: WorkerResult = { contractVersion: "1.0.0", taskId: "x", outcome: "failure", promoted: false, reason: "verifier red", roles: [{ role: "verifier", outcome: "failure" }] };
  const service = fakeService({ runBuild: (t: WorkerTask) => Promise.resolve({ ...failing, taskId: t.taskId }) });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    await waitFor(() => service.registry.get(taskId)?.status !== "running");
    const body = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
    assert.equal(body.status, "failure");
    assert.equal(body.reason, "verifier red");
    assert.equal(body.verificationResult, "fail");
  } finally {
    await app.close();
  }
});

test("a thrown build runner finalizes the task as a failure", async () => {
  const service = fakeService({ runBuild: () => Promise.reject(new Error("boom")) });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    await waitFor(() => service.registry.get(taskId)?.status !== "running");
    const body = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
    assert.equal(body.status, "failure");
    assert.equal(body.reason, "boom");
  } finally {
    await app.close();
  }
});

test("GET /api/tasks/:taskId for an unknown task → 404", async () => {
  const app = await makeApp(fakeService());
  try {
    const res = await app.inject({ method: "GET", url: "/api/tasks/build-does-not-exist" });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("GET /api/tasks → 200 + list with total, filterable by status", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    await app.inject({ method: "POST", url: "/api/build", payload: { goal: "a", repo: REPO } });
    await app.inject({ method: "POST", url: "/api/build", payload: { goal: "b", repo: REPO } });
    const all = (await app.inject({ method: "GET", url: "/api/tasks" })).json();
    assert.equal(all.total, 2);
    assert.equal(all.tasks.length, 2);
    const running = (await app.inject({ method: "GET", url: "/api/tasks?status=running" })).json();
    assert.equal(running.total, 2);
    const done = (await app.inject({ method: "GET", url: "/api/tasks?status=success" })).json();
    assert.equal(done.total, 0);
    const paged = (await app.inject({ method: "GET", url: "/api/tasks?limit=1&offset=0" })).json();
    assert.equal(paged.tasks.length, 1);
    assert.equal(paged.total, 2);
  } finally {
    await app.close();
  }
});

test("POST /api/tasks/:taskId/cancel → 200 + cancelled, and the state reflects it", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { taskId, status: "cancelled" });
    const state = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
    assert.equal(state.status, "cancelled");
    assert.ok(typeof state.finishedAt === "string");
  } finally {
    await app.close();
  }
});

test("cancelling an unknown task → 404; cancelling a finished task → 409", async () => {
  const service = fakeService({ runBuild: (t: WorkerTask) => Promise.resolve(successResult(t.taskId)) });
  const app = await makeApp(service);
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/tasks/nope/cancel" })).statusCode, 404);
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    await waitFor(() => service.registry.get(taskId)?.status !== "running");
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` });
    assert.equal(res.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("a cancelled task's run result does NOT overwrite the cancelled status", async () => {
  let resolve!: () => void;
  const service = fakeService({ runBuild: (t: WorkerTask) => new Promise<WorkerResult>((r) => { resolve = () => r(successResult(t.taskId)); }) });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` });
    resolve(); // the underlying run completes AFTER cancellation
    await waitFor(() => false); // drain microtasks
    assert.equal(service.registry.get(taskId)?.status, "cancelled");
  } finally {
    await app.close();
  }
});

test("rate limiting: a 4th concurrent task → 429", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = await app.inject({ method: "POST", url: "/api/build", payload: { goal: `g${i}`, repo: REPO } });
      assert.equal(r.statusCode, 202);
    }
    const fourth = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g4", repo: REPO } });
    assert.equal(fourth.statusCode, 429);
  } finally {
    await app.close();
  }
});

test("build is unavailable (503) when worker credentials are not configured", async () => {
  const service = new TaskService({ operatorToken: undefined, workerToken: undefined, runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } });
    assert.equal(res.statusCode, 503);
  } finally {
    await app.close();
  }
});

test("IKBI_API_TOKEN gates every /api route with a bearer check", async () => {
  process.env.IKBI_API_TOKEN = "s3cret-token-value";
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const noAuth = await app.inject({ method: "GET", url: "/api/tasks" });
    assert.equal(noAuth.statusCode, 401);
    const badAuth = await app.inject({ method: "GET", url: "/api/tasks", headers: { authorization: "Bearer wrong" } });
    assert.equal(badAuth.statusCode, 401);
    const ok = await app.inject({ method: "GET", url: "/api/tasks", headers: { authorization: "Bearer s3cret-token-value" } });
    assert.equal(ok.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("the tasks routes register via the registerRoutes seam (served by buildServer)", async () => {
  await import("./tasks.js"); // ensure the live registration ran
  const { buildServer } = await import("./index.js");
  const { routes } = await import("./registry.js");
  assert.ok(routes.modules().includes("tasks"), "the 'tasks' module registered its routes");
  const app = buildServer();
  await app.ready();
  try {
    // No IKBI_API_TOKEN ⇒ open; the live service has no test creds, but GET list never needs them.
    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().tasks));
  } finally {
    await app.close();
  }
});
