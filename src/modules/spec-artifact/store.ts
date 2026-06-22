/**
 * ikbi spec-artifact — file-backed spec storage.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SpecArtifact, SpecCardFields, SpecStep } from "./contract.js";

export function resolveStoreDir(override?: string): string {
  return override ?? join(homedir(), ".ikbi", "specs");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function specPath(storeDir: string, id: string): string {
  return join(storeDir, `${id}.json`);
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Build the optional structured-card fields, omitting any that are undefined so the
 * stored object stays clean under `exactOptionalPropertyTypes` (no explicit
 * `key: undefined` entries).
 */
function cardFields(extra?: SpecCardFields): SpecCardFields {
  if (!extra) return {};
  const out: Record<string, unknown> = {};
  if (extra.project !== undefined) out.project = extra.project;
  if (extra.scope !== undefined) out.scope = extra.scope;
  if (extra.rules !== undefined) out.rules = extra.rules;
  if (extra.outputFormat !== undefined) out.outputFormat = extra.outputFormat;
  if (extra.onConflict !== undefined) out.onConflict = extra.onConflict;
  if (extra.corrections !== undefined) out.corrections = extra.corrections;
  if (extra.maxCostUsd !== undefined) out.maxCostUsd = extra.maxCostUsd;
  if (extra.maxFilesChanged !== undefined) out.maxFilesChanged = extra.maxFilesChanged;
  return out as SpecCardFields;
}

/** Create a new spec artifact, optionally with structured spec-card fields. */
export function createSpec(
  goal: string,
  steps: readonly SpecStep[],
  storeDir?: string,
  extra?: SpecCardFields,
): SpecArtifact {
  const dir = resolveStoreDir(storeDir);
  ensureDir(dir);
  const now = new Date().toISOString();
  const spec: SpecArtifact = {
    id: randomUUID(),
    goal,
    steps,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...cardFields(extra),
  };
  writeJson(specPath(dir, spec.id), spec);
  return spec;
}

/** Get a spec by id. */
export function getSpec(id: string, storeDir?: string): SpecArtifact | undefined {
  const dir = resolveStoreDir(storeDir);
  return readJson<SpecArtifact>(specPath(dir, id));
}

/** Update a spec (partial). */
export function updateSpec(id: string, patch: Partial<Omit<SpecArtifact, "id" | "createdAt">>, storeDir?: string): SpecArtifact | undefined {
  const dir = resolveStoreDir(storeDir);
  const existing = readJson<SpecArtifact>(specPath(dir, id));
  if (!existing) return undefined;
  const updated: SpecArtifact = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
  writeJson(specPath(dir, id), updated);
  return updated;
}

/** List all specs. */
export function listSpecs(storeDir?: string): SpecArtifact[] {
  const dir = resolveStoreDir(storeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<SpecArtifact>(join(dir, f)))
    .filter((s): s is SpecArtifact => s !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
