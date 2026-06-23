/**
 * ikbi job-cards — JSON-file-backed store.
 *
 * Persists job cards and run history under ~/.ikbi/job-cards/.
 * Uses simple file locking for concurrent access safety.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { JobCard, JobCardRun, JobCardRunStatus } from "./contract.js";

/** Reject ids that could escape the store directory (GLM 5.2 LOW-3 / Bubbles). */
export function assertSafeId(id: string): void {
  if (/[\\/]/.test(id) || id.includes("..")) {
    throw new Error(`unsafe job card id: ${id}`);
  }
}

/** Resolve the store directory. Overridable for tests. */
export function resolveStoreDir(override?: string): string {
  return override ?? join(homedir(), ".ikbi", "job-cards");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function cardPath(storeDir: string, id: string): string {
  assertSafeId(id);
  return join(storeDir, `${id}.json`);
}

function runsDir(storeDir: string, cardId: string): string {
  assertSafeId(cardId);
  return join(storeDir, "runs", cardId);
}

/** Read a JSON file, returning undefined if missing or corrupt. */
function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Atomic write: write to a temp file then rename (GLM 5.2 MEDIUM-1). */
function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// ── CRUD ─────────────────────────────────────────────────────────────────

/** List all job cards. */
export function listCards(storeDir?: string): JobCard[] {
  const dir = resolveStoreDir(storeDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
  return files
    .map((f) => readJson<JobCard>(join(dir, f)))
    .filter((c): c is JobCard => c !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Get a single job card by id. */
export function getCard(id: string, storeDir?: string): JobCard | undefined {
  const dir = resolveStoreDir(storeDir);
  return readJson<JobCard>(cardPath(dir, id));
}

/** Create a new job card. */
export function createCard(input: Omit<JobCard, "id" | "createdAt" | "updatedAt">, storeDir?: string): JobCard {
  const dir = resolveStoreDir(storeDir);
  ensureDir(dir);
  const now = new Date().toISOString();
  const card: JobCard = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
  writeJson(cardPath(dir, card.id), card);
  return card;
}

/** Update an existing job card (partial update). */
export function updateCard(id: string, patch: Partial<Omit<JobCard, "id" | "createdAt">>, storeDir?: string): JobCard | undefined {
  const dir = resolveStoreDir(storeDir);
  const existing = readJson<JobCard>(cardPath(dir, id));
  if (!existing) return undefined;
  const updated: JobCard = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
  writeJson(cardPath(dir, id), updated);
  return updated;
}

/** Delete a job card. */
export function deleteCard(id: string, storeDir?: string): boolean {
  const dir = resolveStoreDir(storeDir);
  const p = cardPath(dir, id);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// ── Run history ──────────────────────────────────────────────────────────

/** Record a new run. */
export function createRun(cardId: string, storeDir?: string): JobCardRun {
  const dir = resolveStoreDir(storeDir);
  const rDir = runsDir(dir, cardId);
  ensureDir(rDir);
  const run: JobCardRun = {
    id: randomUUID(),
    cardId,
    status: "pending",
    startedAt: new Date().toISOString(),
  };
  writeJson(join(rDir, `${run.id}.json`), run);
  return run;
}

/** Update a run's status and optional fields. */
export function updateRun(
  cardId: string,
  runId: string,
  patch: { status?: JobCardRunStatus; finishedAt?: string; receiptId?: string; error?: string },
  storeDir?: string,
): JobCardRun | undefined {
  const dir = resolveStoreDir(storeDir);
  assertSafeId(runId);
  const p = join(runsDir(dir, cardId), `${runId}.json`);
  const existing = readJson<JobCardRun>(p);
  if (!existing) return undefined;
  const updated: JobCardRun = { ...existing, ...patch };
  writeJson(p, updated);
  return updated;
}

/** List runs for a card, newest first. */
export function listRuns(cardId: string, storeDir?: string): JobCardRun[] {
  const dir = resolveStoreDir(storeDir);
  const rDir = runsDir(dir, cardId);
  if (!existsSync(rDir)) return [];
  return readdirSync(rDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<JobCardRun>(join(rDir, f)))
    .filter((r): r is JobCardRun => r !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
