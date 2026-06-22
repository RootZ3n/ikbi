/**
 * ikbi correction-library — file-backed correction storage.
 *
 * Persists corrections under ~/.ikbi/corrections/, one JSON file per entry.
 * Mirrors the simple, testable store pattern used by job-cards / spec-artifact:
 * every function takes an optional `storeDir` override so tests run in a temp dir.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CorrectionEntry, CorrectionFilter, CorrectionProposeInput } from "./contract.js";

/**
 * Resolve the store directory. Precedence: explicit `override` arg (store tests) →
 * `IKBI_CORRECTIONS_DIR` env (route/server tests, which exercise handlers that call
 * the store WITHOUT an override arg) → the default `~/.ikbi/corrections/`.
 */
export function resolveStoreDir(override?: string): string {
  if (override !== undefined) return override;
  const env = process.env.IKBI_CORRECTIONS_DIR;
  if (env !== undefined && env.trim().length > 0) return env;
  return join(homedir(), ".ikbi", "corrections");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function entryPath(storeDir: string, id: string): string {
  return join(storeDir, `${id}.json`);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Create (propose) a new correction. Fills id, timestamps, and counters; `approved`
 * defaults to false (governance: corrections are proposed, not auto-installed).
 */
export function createCorrection(input: CorrectionProposeInput, storeDir?: string): CorrectionEntry {
  const dir = resolveStoreDir(storeDir);
  ensureDir(dir);
  const now = new Date().toISOString();
  const entry: CorrectionEntry = {
    id: randomUUID(),
    category: input.category,
    finding: input.finding,
    correction: input.correction,
    regression: input.regression,
    ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
    createdAt: now,
    updatedAt: now,
    proposedBy: input.proposedBy ?? "system",
    approved: input.approved === true,
    appliedCount: 0,
  };
  writeJson(entryPath(dir, entry.id), entry);
  return entry;
}

/** Get a correction by id. */
export function getCorrection(id: string, storeDir?: string): CorrectionEntry | undefined {
  const dir = resolveStoreDir(storeDir);
  return readJson<CorrectionEntry>(entryPath(dir, id));
}

/** List all corrections (newest first), optionally filtered by category / approved. */
export function listCorrections(filter?: CorrectionFilter, storeDir?: string): CorrectionEntry[] {
  const dir = resolveStoreDir(storeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<CorrectionEntry>(join(dir, f)))
    .filter((c): c is CorrectionEntry => c !== undefined)
    .filter((c) => (filter?.category !== undefined ? c.category === filter.category : true))
    .filter((c) => (filter?.approved !== undefined ? c.approved === filter.approved : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Approve a correction (set approved=true). Returns undefined if not found. */
export function approveCorrection(id: string, storeDir?: string): CorrectionEntry | undefined {
  const dir = resolveStoreDir(storeDir);
  const existing = readJson<CorrectionEntry>(entryPath(dir, id));
  if (!existing) return undefined;
  const updated: CorrectionEntry = { ...existing, approved: true, updatedAt: new Date().toISOString() };
  writeJson(entryPath(dir, id), updated);
  return updated;
}

/** Reject (delete) a correction. Returns true if it existed. */
export function rejectCorrection(id: string, storeDir?: string): boolean {
  const dir = resolveStoreDir(storeDir);
  const p = entryPath(dir, id);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/**
 * Record that a correction was applied: increment appliedCount and stamp
 * lastAppliedAt. Returns the updated entry, or undefined if not found.
 */
export function recordApplication(id: string, storeDir?: string): CorrectionEntry | undefined {
  const dir = resolveStoreDir(storeDir);
  const existing = readJson<CorrectionEntry>(entryPath(dir, id));
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const updated: CorrectionEntry = {
    ...existing,
    appliedCount: existing.appliedCount + 1,
    lastAppliedAt: now,
    updatedAt: now,
  };
  writeJson(entryPath(dir, id), updated);
  return updated;
}
