import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { atomicWriteFile, atomicWriteJson, classifyDirFsyncError, isTempFile, sweepTempFiles } from "./atomic.js";
import { SubstrateError } from "./contract.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ikbi-atomic-"));
}

test("atomic write produces a complete file and leaves no temp behind", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "f.json");
    await atomicWriteJson(path, { hello: "world" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { hello: "world" });
    const entries = await readdir(dir);
    assert.equal(entries.filter(isTempFile).length, 0, "no temp files remain");
    assert.deepEqual(entries, ["f.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creates parent directories as needed", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "a", "b", "c.json");
    await atomicWriteJson(path, { n: 1 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { n: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reader NEVER sees a partial write under heavy concurrent writes+reads", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "hot.json");
    await atomicWriteJson(path, { n: -1 });
    const blob = "x".repeat(20_000);

    const writers = Array.from({ length: 60 }, (_unused, i) =>
      atomicWriteJson(path, { n: i, blob }, { fsync: false }),
    );
    // Readers run concurrently; each must parse a COMPLETE document (never partial).
    let badReads = 0;
    const readers = Array.from({ length: 400 }, async () => {
      try {
        JSON.parse(await readFile(path, "utf8"));
      } catch {
        badReads += 1;
      }
    });

    await Promise.all([...writers, ...readers]);
    assert.equal(badReads, 0, "every concurrent read parsed a complete file");
    // Final state is one of the complete writes.
    const final = JSON.parse(await readFile(path, "utf8")) as { n: number };
    assert.ok(final.n >= 0 && final.n < 60);
    assert.equal((await readdir(dir)).filter(isTempFile).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweepTempFiles reaps OLD orphaned temp + corrupt sidecars (crash cleanup), nothing else", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "keep.json");
    await atomicWriteJson(path, { keep: true });
    // Simulate sidecars orphaned by a crash mid-write / earlier quarantine.
    await writeFile(`${path}.ikbi-tmp.999.deadbe`, "partial{");
    await writeFile(join(dir, "other.json.ikbi-tmp.1.aa"), "x");
    await writeFile(join(dir, "gone.json.corrupt.123"), "junk");
    // Use a future clock so the just-written sidecars count as "old" deterministically.
    const swept = await sweepTempFiles(dir, { olderThanMs: 0, now: () => Date.now() + 60_000 });
    assert.equal(swept, 3);
    assert.deepEqual(await readdir(dir), ["keep.json"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { keep: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweepTempFiles does NOT reap a fresh (in-flight) temp file", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "live.json.ikbi-tmp.1.bb"), "in flight");
    const swept = await sweepTempFiles(dir); // default 60s threshold; fresh file kept
    assert.equal(swept, 0);
    assert.ok((await readdir(dir)).includes("live.json.ikbi-tmp.1.bb"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real directory-fsync failure surfaces as write_failed (durability not falsely reported)", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "d.json");
    const throwingDirFsync = async (): Promise<void> => {
      throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    };
    await assert.rejects(
      atomicWriteFile(path, "data\n", { fsync: true }, { fsyncDir: throwingDirFsync }),
      (e: unknown) => e instanceof SubstrateError && e.kind === "write_failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyDirFsyncError: unsupported errno is ignored, real errno throws", () => {
  assert.equal(classifyDirFsyncError("EINVAL"), "ignore");
  assert.equal(classifyDirFsyncError("ENOTSUP"), "ignore");
  assert.equal(classifyDirFsyncError("EIO"), "throw");
  assert.equal(classifyDirFsyncError(undefined), "throw");
});
