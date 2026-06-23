import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ContextManager, createContextManager } from "./index.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-ctx-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "auth.ts"), "export function login(){ return true }");
  writeFileSync(join(root, "src", "widgets.ts"), "export const widget = 1");
  writeFileSync(join(root, "README.md"), "# project");
  return root;
}

test("ContextManager indexes lazily and selects relevant files for a prompt", () => {
  const root = makeRepo();
  try {
    const cm = createContextManager(root);
    const sel = cm.select("fix the auth login flow");
    assert.ok(sel.files.length >= 1);
    assert.equal(sel.files[0]!.path, "src/auth.ts");
    assert.ok(sel.tokens > 0);
    assert.equal(sel.indexTruncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected files become hot and are remembered across prompts", () => {
  const root = makeRepo();
  try {
    const cm = new ContextManager(root);
    cm.select("auth login");
    assert.ok(cm.hotPaths().includes("src/auth.ts"));
    // A later, unrelated prompt still keeps the hot file biased upward.
    const sel = cm.select("widget rendering");
    assert.ok(sel.files.some((f) => f.path === "src/auth.ts"), "hot file retained");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a per-prompt token budget bounds what is loaded", () => {
  const root = makeRepo();
  try {
    const cm = new ContextManager(root, { maxTokens: 4 }); // tiny — one small file at most
    const sel = cm.select("auth widget readme");
    assert.ok(sel.tokens <= 4, `selected ${sel.tokens} tokens, budget was 4`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reindex picks up newly created files", () => {
  const root = makeRepo();
  try {
    const cm = new ContextManager(root);
    assert.equal(cm.index().files.length, 3);
    writeFileSync(join(root, "src", "session.ts"), "export const s = 1");
    assert.equal(cm.index().files.length, 3, "cached index unchanged until reindex");
    assert.equal(cm.reindex().files.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
