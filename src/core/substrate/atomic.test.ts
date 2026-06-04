import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { atomicWriteJson, isTempFile, sweepTempFiles } from "./atomic.js";

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

test("sweepTempFiles removes orphaned temp files (crash cleanup) and nothing else", async () => {
  const dir = await tmp();
  try {
    const path = join(dir, "keep.json");
    await atomicWriteJson(path, { keep: true });
    // Simulate temp files orphaned by a crash mid-write.
    await writeFile(`${path}.ikbi-tmp.999.deadbe`, "partial{");
    await writeFile(join(dir, "other.json.ikbi-tmp.1.aa"), "x");
    const swept = await sweepTempFiles(dir);
    assert.equal(swept, 2);
    assert.deepEqual(await readdir(dir), ["keep.json"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { keep: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
