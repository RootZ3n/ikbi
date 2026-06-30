/**
 * Tests for the consult code-slice reader: verbatim line windows + confinement.
 * node:test against a real temp repo (the reader is fs-bound).
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readCodeSlice } from "./codeSlice.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-slice-"));
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(path.join(root, "a.ts"), `${lines}\n`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "b.ts"), "alpha\nbeta\ngamma\n");
  return root;
}

test("reads a verbatim inclusive line window", async () => {
  const root = await makeRepo();
  try {
    const { slice, skip } = await readCodeSlice(root, { path: "a.ts", startLine: 3, endLine: 5 });
    assert.equal(skip, undefined);
    assert.ok(slice);
    assert.equal(slice.startLine, 3);
    assert.equal(slice.endLine, 5);
    assert.equal(slice.text, "line 3\nline 4\nline 5");
    assert.equal(slice.truncated, false);
    assert.equal(slice.bytes, Buffer.byteLength(slice.text, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clamps endLine past EOF and flags truncated", async () => {
  const root = await makeRepo();
  try {
    const { slice } = await readCodeSlice(root, { path: "src/b.ts", startLine: 2, endLine: 999 });
    assert.ok(slice);
    assert.equal(slice.startLine, 2);
    assert.equal(slice.endLine, 3); // file has 3 content lines
    assert.equal(slice.text, "beta\ngamma");
    assert.equal(slice.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips when startLine is beyond end of file", async () => {
  const root = await makeRepo();
  try {
    const { slice, skip } = await readCodeSlice(root, { path: "src/b.ts", startLine: 50, endLine: 60 });
    assert.equal(slice, undefined);
    assert.ok(skip);
    assert.match(skip.reason, /beyond end of file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps slice text at the per-slice byte budget", async () => {
  const root = await makeRepo();
  try {
    const { slice } = await readCodeSlice(root, { path: "a.ts", startLine: 1, endLine: 20 }, { maxSliceBytes: 10 });
    assert.ok(slice);
    assert.ok(slice.bytes <= 10);
    assert.equal(slice.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid ranges", async () => {
  const root = await makeRepo();
  try {
    const bad = await readCodeSlice(root, { path: "a.ts", startLine: 5, endLine: 2 });
    assert.match(bad.skip?.reason ?? "", /startLine must be <= endLine/);
    const zero = await readCodeSlice(root, { path: "a.ts", startLine: 0, endLine: 1 });
    assert.match(zero.skip?.reason ?? "", /positive integers/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confinement: absolute paths, traversal, and out-of-root are skipped not read", async () => {
  const root = await makeRepo();
  try {
    const abs = await readCodeSlice(root, { path: path.join(root, "a.ts"), startLine: 1, endLine: 1 });
    assert.match(abs.skip?.reason ?? "", /absolute paths/);
    const trav = await readCodeSlice(root, { path: "../a.ts", startLine: 1, endLine: 1 });
    assert.match(trav.skip?.reason ?? "", /traversal/);
    const missing = await readCodeSlice(root, { path: "nope.ts", startLine: 1, endLine: 1 });
    assert.match(missing.skip?.reason ?? "", /does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confinement: symlinked path segment is not followed", async () => {
  const root = await makeRepo();
  try {
    const outside = await mkdtemp(path.join(tmpdir(), "ikbi-outside-"));
    await writeFile(path.join(outside, "secret.ts"), "TOP SECRET\n");
    await symlink(outside, path.join(root, "link"));
    const result = await readCodeSlice(root, { path: "link/secret.ts", startLine: 1, endLine: 1 });
    assert.equal(result.slice, undefined);
    assert.match(result.skip?.reason ?? "", /symlinks are not followed/);
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
