/**
 * ikbi spec-artifact — file-backed spec storage.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SpecArtifact, SpecStep } from "./contract.js";

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

/** Create a new spec artifact. */
export function createSpec(goal: string, steps: readonly SpecStep[], storeDir?: string): SpecArtifact {
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
