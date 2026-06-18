/**
 * ikbi governed-exec — BACKGROUND JOB MANAGER.
 *
 * A background command (dev server, watch mode, a >30s suite) is spawned DETACHED — its own
 * process group — so the whole tree can be killed and grandchildren cannot orphan. Unlike a
 * foreground command there is NO wall-clock timeout: the job runs until it exits on its own or
 * is killed. The executor calls in here ONLY after a command has cleared the same gate-wall +
 * allowlist + policy + receipt path a foreground command passes — this module performs NO
 * governance of its own; it is the post-authorization spawn + lifecycle surface.
 *
 * Output (stdout AND stderr, interleaved in arrival order) is captured to a per-job temp file so
 * it can be polled INCREMENTALLY by byte offset without holding the whole stream in memory — a
 * long-running dev server would otherwise grow an unbounded buffer. Capture is bounded by
 * `maxBuffer`; past the cap a single truncation notice is appended and further output dropped.
 *
 * `dispose()` SIGKILLs every still-running job's process group and removes the temp directory —
 * the session-end cleanup hook (idempotent, best-effort).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_JOB_KILL_GRACE_MS, DEFAULT_MAX_BUFFER } from "./config.js";
import type { JobKillResult, JobOutputResult, JobState, JobStatusResult, JobSummary } from "./contract.js";

/**
 * The minimal child-process shape the job manager depends on (a subset of node's `ChildProcess`).
 * Tests substitute a fake so background lifecycle is exercised without real processes.
 */
export interface BackgroundChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The detached-spawn primitive (array args, NO shell). Tests substitute this. */
export type SpawnBackgroundFn = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => BackgroundChildProcess;

/** Default spawn: detached process group, stdout/stderr piped for capture (no stdin). */
const defaultSpawnBackground: SpawnBackgroundFn = (command, args, opts) =>
  nodeSpawn(command, args as string[], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: opts.env,
    detached: true, // own process group — lets us SIGKILL the whole tree, not just the direct child
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Injectable dependencies for the job manager (tests substitute spawn / killGroup / grace / ids). */
export interface JobManagerDeps {
  /** The detached-spawn primitive. Default: node spawn (detached, piped). */
  readonly spawn?: SpawnBackgroundFn;
  /** Signal a whole process GROUP (negative-pid kill). Default: `process.kill(-pid, signal)`. */
  readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Grace (ms) between SIGTERM and SIGKILL. Default: `DEFAULT_JOB_KILL_GRACE_MS`. */
  readonly killGraceMs?: number;
  /** Max captured bytes per job (output past this is dropped with a notice). Default: `DEFAULT_MAX_BUFFER`. */
  readonly maxBuffer?: number;
  /** Base directory for per-job temp output files. Default: the OS temp dir. */
  readonly tmpDirBase?: string;
  /** Short unique id generator. Default: 8 hex chars from `crypto.randomBytes`. */
  readonly genId?: () => string;
}

/** A request to spawn a background job (already authorized by the executor). */
export interface SpawnJobRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The background-job lifecycle surface the executor exposes (list/read/kill/status/dispose). */
export interface JobManager {
  spawn(request: SpawnJobRequest): { jobId: string; pid: number | undefined };
  list(): JobSummary[];
  readOutput(jobId: string, offset?: number): JobOutputResult;
  kill(jobId: string): JobKillResult;
  status(jobId: string): JobStatusResult;
  dispose(): void;
}

/** Internal mutable record for a tracked job. */
interface JobRecord {
  readonly id: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly child: BackgroundChildProcess;
  readonly outputPath: string;
  status: JobState;
  exitCode: number | undefined;
  bytesWritten: number;
  truncated: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

/** Build a background-job manager. The default deps wire node spawn + process-group kill. */
export function createJobManager(deps: JobManagerDeps = {}): JobManager {
  const spawnFn = deps.spawn ?? defaultSpawnBackground;
  const killGroupFn = deps.killGroup ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(-pid, signal); });
  const killGraceMs = deps.killGraceMs ?? DEFAULT_JOB_KILL_GRACE_MS;
  const maxBuffer = deps.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const genId = deps.genId ?? (() => randomBytes(4).toString("hex"));

  const jobs = new Map<string, JobRecord>();
  let dir: string | undefined; // created lazily on the first spawn

  const baseDir = (): string => {
    if (dir === undefined) dir = mkdtempSync(join(deps.tmpDirBase ?? tmpdir(), "ikbi-job-"));
    return dir;
  };

  const uniqueId = (): string => {
    for (let i = 0; i < 1000; i += 1) {
      const id = genId();
      if (!jobs.has(id)) return id;
    }
    // Astronomically unlikely; fall back to a longer id rather than loop forever.
    return randomBytes(8).toString("hex");
  };

  /** Append a captured chunk to the job's output file, honoring the per-job byte cap. */
  const append = (job: JobRecord, chunk: string): void => {
    if (job.truncated) return;
    const buf = Buffer.from(chunk, "utf8");
    const room = maxBuffer - job.bytesWritten;
    const toWrite = buf.length > room ? buf.subarray(0, Math.max(0, room)) : buf;
    if (toWrite.length > 0) {
      try { appendFileSync(job.outputPath, toWrite); } catch { /* best-effort capture */ }
      job.bytesWritten += toWrite.length;
    }
    if (buf.length > room) {
      job.truncated = true;
      const notice = Buffer.from(`\n[output truncated at ${maxBuffer} bytes]\n`, "utf8");
      try { appendFileSync(job.outputPath, notice); } catch { /* best-effort */ }
      job.bytesWritten += notice.length;
    }
  };

  const clearKillTimer = (job: JobRecord): void => {
    if (job.killTimer !== undefined) {
      clearTimeout(job.killTimer);
      job.killTimer = undefined;
    }
  };

  /** Signal a job's process GROUP (falling back to the direct child if the group kill throws). */
  const signal = (job: JobRecord, sig: NodeJS.Signals): void => {
    try {
      if (job.pid !== undefined) killGroupFn(job.pid, sig);
      else job.child.kill(sig);
    } catch {
      try { job.child.kill(sig); } catch { /* already dead */ }
    }
  };

  const spawn = (request: SpawnJobRequest): { jobId: string; pid: number | undefined } => {
    const id = uniqueId();
    const outputPath = join(baseDir(), `${id}.log`);
    try { closeSync(openSync(outputPath, "w")); } catch { /* file is created lazily on first append otherwise */ }
    const child = spawnFn(request.command, request.args, {
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      env: request.env,
    });
    const job: JobRecord = {
      id,
      command: [request.command, ...request.args].join(" "),
      pid: child.pid,
      child,
      outputPath,
      status: "running",
      exitCode: undefined,
      bytesWritten: 0,
      truncated: false,
      killTimer: undefined,
    };
    jobs.set(id, job);
    const onData = (chunk: Buffer | string): void => append(job, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      append(job, `${err instanceof Error ? err.message : String(err)}\n`);
      if (job.status === "running") {
        job.status = "exited";
        job.exitCode = 1;
      }
      clearKillTimer(job);
    });
    child.on("close", (code) => {
      // A killed job stays "killed" (records the exit code); a natural exit becomes "exited".
      if (job.status !== "killed") job.status = "exited";
      job.exitCode = code ?? job.exitCode ?? 0;
      clearKillTimer(job);
    });
    return { jobId: id, pid: child.pid };
  };

  const list = (): JobSummary[] =>
    [...jobs.values()].map((j) => ({
      id: j.id,
      pid: j.pid,
      command: j.command,
      status: j.status,
      ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
    }));

  const readOutput = (jobId: string, offset = 0): JobOutputResult => {
    const job = jobs.get(jobId);
    if (job === undefined) return { found: false, output: "", nextOffset: Math.max(0, offset) };
    const start = Math.max(0, Math.min(offset, job.bytesWritten));
    let output = "";
    if (start < job.bytesWritten) {
      const len = job.bytesWritten - start;
      try {
        const fd = openSync(job.outputPath, "r");
        try {
          const buf = Buffer.alloc(len);
          const read = readSync(fd, buf, 0, len, start);
          output = buf.subarray(0, read).toString("utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        output = "";
      }
    }
    return {
      found: true,
      output,
      nextOffset: job.bytesWritten,
      status: job.status,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    };
  };

  const kill = (jobId: string): JobKillResult => {
    const job = jobs.get(jobId);
    if (job === undefined) return { found: false };
    if (job.status !== "running") return { found: true }; // already finished — nothing to signal
    job.status = "killed";
    signal(job, "SIGTERM");
    const timer = setTimeout(() => { signal(job, "SIGKILL"); }, killGraceMs);
    if (typeof timer.unref === "function") timer.unref(); // don't keep the event loop alive for the grace window
    job.killTimer = timer;
    return { found: true };
  };

  const status = (jobId: string): JobStatusResult => {
    const job = jobs.get(jobId);
    if (job === undefined) return { found: false };
    return { found: true, status: job.status, ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) };
  };

  const dispose = (): void => {
    for (const job of jobs.values()) {
      clearKillTimer(job);
      if (job.status === "running") {
        job.status = "killed";
        signal(job, "SIGKILL");
      }
    }
    jobs.clear();
    if (dir !== undefined) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      dir = undefined;
    }
  };

  return { spawn, list, readOutput, kill, status, dispose };
}
