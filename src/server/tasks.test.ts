import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import type { WorkerResult, WorkerTask } from "../modules/worker-model/index.js";
import type { FixOutcome } from "../modules/worker-model/fix.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import type { EventBusSurface, IkbiEvent } from "../core/events/index.js";
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

/** A minimal FixOutcome fixture (finalizeFix reads only result / filesModified / fullCheck.passed). */
function fixOutcome(result: string): FixOutcome {
  return {
    result,
    filesModified: [],
    promoted: false,
    receipt: { fullCheck: { passed: false } },
    diagnosis: {},
  } as unknown as FixOutcome;
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
  // Allow the temp REPO so the build/fix routes pass the allowlist (MEDIUM 6) in tests.
  process.env.IKBI_API_ALLOWED_REPOS = REPO;
});
afterEach(() => {
  delete process.env.IKBI_API_TOKEN;
  delete process.env.IKBI_API_ALLOWED_REPOS;
  delete process.env.IKBI_SSE_IDLE_MS;
});

test("POST /api/build with a valid request → 202 + taskId", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) }); // never resolves: stays running
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "Fix the login bug", repo: REPO } });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.match(body.taskId, /^build-\d+-\d+$/);
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
    assert.match(res.json().taskId, /^fix-\d+-\d+$/);
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

test("POST /api/tasks/:taskId/cancel → 200 + cancelling while the run drains (slot held)", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) }); // never resolves: keeps draining
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } })).json().taskId;
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` });
    assert.equal(res.statusCode, 200);
    // The run hasn't actually stopped yet → non-terminal "cancelling", no finishedAt, slot still held.
    assert.deepEqual(res.json(), { taskId, status: "cancelling" });
    const state = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
    assert.equal(state.status, "cancelling");
    assert.equal(state.finishedAt, undefined);
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

test("a fix run receives the cancellation seam; SAFE_FAIL after cancel settles to cancelled (H1)", async () => {
  let observedCancelled: (() => boolean) | undefined;
  let release!: () => void;
  const service = fakeService({
    runFix: (_req, _ctx, isCancelled) => {
      // The service must THREAD its cancellation seam into the injected runner (H1).
      observedCancelled = isCancelled;
      return new Promise<FixOutcome>((r) => { release = () => r(fixOutcome("SAFE_FAIL")); });
    },
  });
  const app = await makeApp(service);
  try {
    const taskId = (await app.inject({ method: "POST", url: "/api/fix", payload: { repo: REPO } })).json().taskId;
    await waitFor(() => observedCancelled !== undefined);
    assert.equal(observedCancelled!(), false); // not cancelled yet
    const c = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` });
    assert.equal(c.statusCode, 200);
    assert.equal(observedCancelled!(), true); // the seam now reflects the cancellation — the pipeline can stop early
    release(); // the pipeline returns a SAFE_FAIL once it has seen the cancellation
    await waitFor(() => service.registry.get(taskId)?.status === "cancelled");
    // A cancelled fix settles to the terminal `cancelled` status — never a regular `failure`.
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

// ── HARDENING REGRESSION TESTS (Codex adversarial audit) ─────────────────────

test("task ids are unique even for same-millisecond submissions (H5)", async () => {
  // A fixed clock forces every id onto the same millisecond — the counter suffix must disambiguate.
  const service = fakeService({ now: () => 1000, runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const r = await app.inject({ method: "POST", url: "/api/build", payload: { goal: `g${i}`, repo: REPO } });
      assert.equal(r.statusCode, 202); // pre-fix the 2nd add() threw (duplicate id) → 500
      ids.add(r.json().taskId);
    }
    assert.equal(ids.size, 3);
  } finally {
    await app.close();
  }
});

test("rate limiting: a cancelled-but-still-draining task keeps its slot (H2)", async () => {
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) }); // runs never resolve
  const app = await makeApp(service);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await app.inject({ method: "POST", url: "/api/build", payload: { goal: `g${i}`, repo: REPO } });
      assert.equal(r.statusCode, 202);
      ids.push(r.json().taskId);
    }
    const c = await app.inject({ method: "POST", url: `/api/tasks/${ids[0]}/cancel` });
    assert.equal(c.statusCode, 200);
    assert.equal(c.json().status, "cancelling");
    // The cancelled run hasn't actually stopped, so its slot is still held: a 4th submit is rejected.
    const fourth = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g4", repo: REPO } });
    assert.equal(fourth.statusCode, 429);
  } finally {
    await app.close();
  }
});

test("a finished run releases its slot, re-opening capacity", async () => {
  let resolveOne!: () => void;
  let resolved = false;
  const service = fakeService({
    runBuild: (t: WorkerTask) =>
      resolved ? new Promise<WorkerResult>(() => {}) : new Promise<WorkerResult>((r) => { resolveOne = () => { resolved = true; r(successResult(t.taskId)); }; }),
  });
  const app = await makeApp(service);
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await app.inject({ method: "POST", url: "/api/build", payload: { goal: `g${i}`, repo: REPO } })).statusCode, 202);
    assert.equal((await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g4", repo: REPO } })).statusCode, 429);
    resolveOne(); // the first run completes → its slot frees
    await waitFor(() => !service.atCapacity());
    assert.equal((await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g5", repo: REPO } })).statusCode, 202);
  } finally {
    await app.close();
  }
});

test("POST /api/build for a repo outside the allowlist → 403 (MEDIUM 6)", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ikbi-task-outside-")); // exists, but not the allowlisted REPO
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: outside } });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /not allowed/);
  } finally {
    await app.close();
  }
});

test("POST /api/fix for a repo outside the allowlist → 403 (MEDIUM 6)", async () => {
  const outside = mkdtempSync(join(tmpdir(), "ikbi-task-outside-fix-"));
  const service = fakeService({ runFix: () => new Promise(() => {}) });
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/fix", payload: { repo: outside } });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("IKBI_API_ALLOWED_REPOS glob patterns admit a matching repo", async () => {
  process.env.IKBI_API_ALLOWED_REPOS = `${tmpdir()}/**`; // a glob covering all temp dirs
  const service = fakeService({ runBuild: () => new Promise<WorkerResult>(() => {}) });
  const app = await makeApp(service);
  try {
    const res = await app.inject({ method: "POST", url: "/api/build", payload: { goal: "g", repo: REPO } });
    assert.equal(res.statusCode, 202);
  } finally {
    await app.close();
  }
});

// A minimal in-memory event bus so an SSE test owns an isolated bus shared by the service + stream.
function makeBus(): EventBusSurface {
  const subs = new Set<{ match: (e: IkbiEvent) => boolean; handler: (e: IkbiEvent) => void }>();
  return {
    publish(input) {
      const e = { ...input, id: "evt", seq: 0, timestamp: "t", contractVersion: "1.0.0" } as unknown as IkbiEvent;
      for (const s of subs) if (s.match(e)) queueMicrotask(() => s.handler(e));
      return e as never;
    },
    subscribe(opts, handler) {
      const match = (e: IkbiEvent): boolean => {
        if (opts.types && !opts.types.includes(e.type)) return false;
        if (opts.typePrefix && !e.type.startsWith(opts.typePrefix)) return false;
        if (opts.predicate && !opts.predicate(e)) return false;
        return true;
      };
      const rec = { match, handler: handler as (e: IkbiEvent) => void };
      subs.add(rec);
      return { id: "sub", unsubscribe: () => subs.delete(rec), stats: () => ({ delivered: 0, dropped: 0, failures: 0, queued: 0 }) };
    },
    flush: () => Promise.resolve(),
  };
}

/** Open a real SSE stream, run `act` once it's connected, and resolve with everything the stream wrote before it closed. */
async function openSseAndAct(service: TaskService, bus: EventBusSurface, path: string, act: () => void): Promise<string> {
  const app = Fastify();
  registerTaskRoutes(app, service, bus);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  try {
    return await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: addr.port, path }, (res) => {
        let data = "";
        res.on("data", (c) => { data += String(c); });
        res.on("end", () => resolve(data));
        res.on("error", reject);
        setImmediate(() => setImmediate(act)); // act once the stream is subscribed
      });
      req.on("error", reject);
      const t = setTimeout(() => reject(new Error("SSE stream did not close in time")), 5000);
      t.unref();
    });
  } finally {
    await app.close();
  }
}

test("SSE stream closes (cleans up) when its task is cancelled (H4)", async () => {
  const bus = makeBus();
  const service = fakeService({ events: bus, runBuild: () => new Promise<WorkerResult>(() => {}) });
  const taskId = service.submitBuild({ goal: "g", repo: REPO });
  const data = await openSseAndAct(service, bus, `/api/tasks/${taskId}/stream`, () => { service.cancel(taskId); });
  assert.match(data, /event: task_completed/);
});

test("SSE cancellation frame reports the TERMINAL 'cancelled' status, not 'cancelling' (H4)", async () => {
  const bus = makeBus();
  const service = fakeService({ events: bus, runBuild: () => new Promise<WorkerResult>(() => {}) });
  const taskId = service.submitBuild({ goal: "g", repo: REPO });
  const data = await openSseAndAct(service, bus, `/api/tasks/${taskId}/stream`, () => { service.cancel(taskId); });
  assert.match(data, /event: task_completed/);
  // The task is still in the non-terminal `cancelling` state when task.cancelled fires, but the
  // final frame must carry the TERMINAL `cancelled` status so a client reading it sees a terminal state.
  assert.match(data, /"status":"cancelled"/);
  assert.doesNotMatch(data, /"status":"cancelling"/);
});

test("SSE stream closes (cleans up) when its task errors (H4)", async () => {
  const bus = makeBus();
  let fail!: () => void;
  const service = fakeService({ events: bus, runBuild: () => new Promise<WorkerResult>((_, r) => { fail = () => r(new Error("boom")); }) });
  const taskId = service.submitBuild({ goal: "g", repo: REPO });
  const data = await openSseAndAct(service, bus, `/api/tasks/${taskId}/stream`, () => { fail(); });
  assert.match(data, /event: task_completed/);
});

test("SSE stream force-closes after the idle timeout (H4)", async () => {
  process.env.IKBI_SSE_IDLE_MS = "120";
  const bus = makeBus();
  const service = fakeService({ events: bus, runBuild: () => new Promise<WorkerResult>(() => {}) });
  const taskId = service.submitBuild({ goal: "g", repo: REPO });
  const data = await openSseAndAct(service, bus, `/api/tasks/${taskId}/stream`, () => { /* stay idle */ });
  assert.match(data, /event: timeout/);
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
