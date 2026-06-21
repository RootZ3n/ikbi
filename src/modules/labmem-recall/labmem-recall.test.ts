/**
 * labmem-recall adapter tests (Phase 4 labmem-integration hardening).
 *
 * ikbi's labmem surface is READ-ONLY: recallForIkbi composes shared + own +
 * project memory for ikbi and must never leak another agent's private memory.
 *
 * The adapter imports labmem CODE from LABMEM_ROOT (env) but reads DATA from the
 * `root` argument, so we point LABMEM_ROOT at the real built labmem for code and
 * seed an isolated temp data root. (The unavailable/LabmemUnavailable path lives
 * in labmem-recall-unavailable.test.ts so it runs in its own process before the
 * adapter caches the labmem module.)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { recallForIkbi, IKBI_AGENT } from "./index.js";

// Portable: the in-ecosystem vendored labmem (CODE) — override with LABMEM_REAL.
const REAL_LABMEM = process.env["LABMEM_REAL"] ?? (() => {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) { if (basename(d) === "ecosystem") return join(d, "lab-memory", "labmem"); const p = dirname(d); if (p === d) break; d = p; }
  return join(process.cwd(), "lab-memory", "labmem");
})();

// Non-literal path → the typechecker treats the imported module as `any`.
async function labmem(): Promise<unknown> {
  return import(REAL_LABMEM + "/dist/index.js");
}

async function seed(root: string): Promise<void> {
  const m = (await labmem()) as { createStore: (o: { root: string }) => { addMemory: (i: Record<string, unknown>) => unknown } };
  const store = m.createStore({ root });
  const base = { confidence: "observed", source: "test", actor: "test" };
  store.addMemory({ ...base, id: "lab-rule", scope: "global", namespace: "global", memoryType: "shared", title: "Lab rule alpha", description: "a shared lab-wide rule", body: "all agents follow alpha" });
  store.addMemory({ ...base, id: "own-fact", scope: "agent", namespace: IKBI_AGENT, memoryType: "semantic", title: "Own fact beta", description: "ikbi private", body: "beta" });
  store.addMemory({ ...base, id: "proj-fact", scope: "project", namespace: IKBI_AGENT, memoryType: "project", title: "Project fact gamma", description: "ikbi project memory", body: "gamma" });
  store.addMemory({ ...base, id: "foreign-secret", scope: "agent", namespace: "other-agent", shared: false, memoryType: "semantic", title: "Foreign secret delta", description: "another agent private", body: "delta" });
}

test("recallForIkbi returns shared + own + project memory and hides other agents private memory", async () => {
  const prev = process.env["LABMEM_ROOT"];
  process.env["LABMEM_ROOT"] = REAL_LABMEM; // code import source
  const root = mkdtempSync(join(tmpdir(), "labmem-ikbi-recall-")); // isolated data root
  try {
    await seed(root);
    const r = await recallForIkbi(root);
    const ids = (xs: unknown[]): string[] => xs.map((m) => (m as { id: string }).id);

    assert.ok(ids(r.shared).includes("lab-rule"), "shared memory must be recalled");
    assert.ok(ids(r.own).includes("own-fact"), "own memory must be recalled");
    assert.ok(ids(r.projects).includes("proj-fact"), "project memory must be recalled");

    const all = [...ids(r.shared), ...ids(r.own), ...ids(r.projects)];
    assert.ok(!all.includes("foreign-secret"), "another agent private memory must NOT leak");
  } finally {
    if (prev === undefined) delete process.env["LABMEM_ROOT"];
    else process.env["LABMEM_ROOT"] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
