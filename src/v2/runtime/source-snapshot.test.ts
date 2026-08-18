/**
 * THE SOURCE SNAPSHOT AUTHORITY — capture policy, identity, and drift immunity.
 *
 * Real git repositories. The load-bearing assertions are that the snapshot is exactly
 * what the OPERATOR sees — including uncommitted work — that git's own ignore rules do
 * the excluding, and that a source repository edited after capture cannot change what the
 * run reads.
 *
 * Capability: git (registered in scripts/test-runner.sh).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { V2_SOURCE_FAILURE_CODES, type SourceSnapshot } from "../core/source.js";
import { initGitRepo, writeFiles } from "../cli/fixture-repo.js";
import { createSourceSnapshotAuthority, parsePorcelain } from "./source-snapshot.js";

const repos: string[] = [];
after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Readonly<Record<string, string>> = {}): string {
  const r = initGitRepo(files);
  repos.push(r);
  return r;
}

const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

async function capture(repoPath: string) {
  const authority = createSourceSnapshotAuthority();
  const result = await authority.capture({ repoPath });
  assert.ok(result.ok, `capture failed: ${result.ok ? "" : result.failure.message}`);
  return { reader: result.reader, snapshot: result.reader.snapshot, authority };
}

const entryFor = (snapshot: SourceSnapshot, path: string) => snapshot.entries.find((e) => e.path === path);

// ── clean ───────────────────────────────────────────────────────────────────

test("snapshot: a CLEAN checkout has an empty delta and is marked clean", async () => {
  const { snapshot } = await capture(repo({ "src/a.ts": "A\n" }));
  assert.equal(snapshot.clean, true);
  assert.deepEqual([...snapshot.entries], []);
  assert.deepEqual(snapshot.counts, { modified: 0, deleted: 0, untrackedIncluded: 0, excluded: 0 });
});

test("snapshot: a clean checkout serves file content from the immutable HEAD blob", async () => {
  const { reader } = await capture(repo({ "src/a.ts": "A\n" }));
  const read = await reader.read("src/a.ts");
  assert.ok(read.ok);
  assert.equal(read.content, "A\n");
  assert.equal(read.origin, "head_blob");
  assert.equal(read.contentSha256, sha("A\n"));
});

// ── dirty ───────────────────────────────────────────────────────────────────

test("snapshot: a MODIFIED tracked file is captured as the operator sees it", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  writeFiles(r, { "src/a.ts": "B\n" });
  const { snapshot, reader } = await capture(r);

  assert.equal(snapshot.clean, false);
  assert.equal(entryFor(snapshot, "src/a.ts")?.status, "modified");
  assert.equal(entryFor(snapshot, "src/a.ts")?.contentSha256, sha("B\n"));
  const read = await reader.read("src/a.ts");
  assert.ok(read.ok);
  assert.equal(read.content, "B\n", "not the committed A");
  assert.equal(read.origin, "snapshot_delta");
});

test("snapshot: a DELETED tracked file is recorded as deleted and reads as missing", async () => {
  const r = repo({ "src/gone.ts": "bye\n" });
  rmSync(join(r, "src/gone.ts"));
  const { snapshot, reader } = await capture(r);
  assert.equal(entryFor(snapshot, "src/gone.ts")?.status, "deleted");
  assert.equal(entryFor(snapshot, "src/gone.ts")?.kind, "deleted");
  assert.equal(snapshot.counts.deleted, 1);
  const read = await reader.read("src/gone.ts");
  assert.equal(read.ok, false);
  assert.ok(!read.ok);
  assert.equal(read.reason, "missing");
});

test("snapshot: an UNTRACKED source file is included under the default policy", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  writeFiles(r, { "src/new.ts": "brand new\n" });
  const { snapshot, reader } = await capture(r);
  assert.equal(entryFor(snapshot, "src/new.ts")?.status, "untracked");
  assert.equal(snapshot.counts.untrackedIncluded, 1);
  const read = await reader.read("src/new.ts");
  assert.ok(read.ok);
  assert.equal(read.content, "brand new\n", "work the operator has not committed does not disappear");
});

test("snapshot: an IGNORED file is not source and is not captured", async () => {
  const r = repo({ ".gitignore": "dist/\n", "src/a.ts": "A\n" });
  writeFiles(r, { "dist/junk.js": "generated\n" });
  const { snapshot, reader } = await capture(r);
  assert.equal(entryFor(snapshot, "dist/junk.js"), undefined, "git's own ignore rules do the excluding");
  assert.equal(snapshot.clean, true, "ignored debris does not make a checkout dirty");
  const read = await reader.read("dist/junk.js");
  assert.equal(read.ok, false);
});

test("snapshot: the executable bit is a real source fact and is captured", async () => {
  const r = repo({ "run.sh": "#!/bin/sh\necho hi\n" });
  chmodSync(join(r, "run.sh"), 0o755);
  const { snapshot } = await capture(r);
  assert.equal(entryFor(snapshot, "run.sh")?.executable, true);
});

test("snapshot: a symlink is captured as a symlink, not as its target's content", async () => {
  const r = repo({ "real.txt": "target\n" });
  symlinkSync("real.txt", join(r, "link.txt"));
  const { snapshot, reader } = await capture(r);
  assert.equal(entryFor(snapshot, "link.txt")?.kind, "symlink");
  assert.equal(entryFor(snapshot, "link.txt")?.symlinkTarget, "real.txt");
  const read = await reader.read("link.txt");
  assert.equal(read.ok, false, "a symlink is not served as file content");
});

// ── index semantics ─────────────────────────────────────────────────────────

test("snapshot: HEAD=A, index=B, working tree=C captures C — what the operator sees", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  writeFiles(r, { "src/a.ts": "B\n" });
  execFileSync("git", ["add", "src/a.ts"], { cwd: r });
  writeFiles(r, { "src/a.ts": "C\n" });

  const { snapshot, reader } = await capture(r);
  assert.equal(entryFor(snapshot, "src/a.ts")?.contentSha256, sha("C\n"));
  const read = await reader.read("src/a.ts");
  assert.ok(read.ok);
  assert.equal(read.content, "C\n", "the staging area is evidence, not a second source reality");
  assert.notEqual(read.content, "B\n");
});

test("snapshot: a STAGED deletion is a deletion — the operator does not see the file", async () => {
  const r = repo({ "src/gone.ts": "bye\n" });
  execFileSync("git", ["rm", "-q", "src/gone.ts"], { cwd: r });
  const { snapshot } = await capture(r);
  assert.equal(entryFor(snapshot, "src/gone.ts")?.status, "deleted");
});

// ── identity ────────────────────────────────────────────────────────────────

test("identity: the same state captures the same snapshot id", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  writeFiles(r, { "src/a.ts": "B\n" });
  assert.equal((await capture(r)).snapshot.snapshotId, (await capture(r)).snapshot.snapshotId);
});

test("identity: two DIRTY states over the same HEAD get different snapshot ids", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  writeFiles(r, { "src/a.ts": "B\n" });
  const first = (await capture(r)).snapshot;
  writeFiles(r, { "src/a.ts": "C\n" });
  const second = (await capture(r)).snapshot;

  assert.equal(first.headCommit, second.headCommit, "the same commit");
  assert.notEqual(first.snapshotId, second.snapshotId, "but not the same source state");
});

test("identity: a dirty snapshot differs from the clean snapshot of the same HEAD", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  const clean = (await capture(r)).snapshot;
  writeFiles(r, { "src/a.ts": "B\n" });
  const dirty = (await capture(r)).snapshot;
  assert.notEqual(clean.snapshotId, dirty.snapshotId);
  assert.equal(clean.clean, true);
  assert.equal(dirty.clean, false);
});

test("identity: the checkout LOCATION does not affect the snapshot id", async () => {
  const first = repo({ "src/a.ts": "A\n" });
  const second = repo({ "src/a.ts": "A\n" });
  // Same content, same tree, different directories — and the fixture commits are made
  // with a fixed identity, so HEAD matches too.
  const a = (await capture(first)).snapshot;
  const b = (await capture(second)).snapshot;
  assert.equal(a.headTree, b.headTree, "same tree");
  assert.equal(a.snapshotId, b.snapshotId, "so the same source state, wherever it lives");
});

// ── drift immunity ──────────────────────────────────────────────────────────

test("drift: editing the source AFTER capture cannot change what the run reads", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  writeFiles(r, { "src/a.ts": "B\n" });
  const { reader, snapshot } = await capture(r);

  // The operator keeps working while the run is in flight.
  writeFiles(r, { "src/a.ts": "C-after-capture\n", "src/late.ts": "appeared late\n" });

  const read = await reader.read("src/a.ts");
  assert.ok(read.ok);
  assert.equal(read.content, "B\n", "the run stays bound to the state it started from");
  const late = await reader.read("src/late.ts");
  assert.equal(late.ok, false, "a file created after capture is not part of this run's source");
  assert.equal(snapshot.counts.untrackedIncluded, 0);
});

test("drift: a clean-path read survives a post-capture edit, because HEAD cannot change", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  const { reader } = await capture(r);
  writeFiles(r, { "src/a.ts": "EDITED-AFTER\n" });
  const read = await reader.read("src/a.ts");
  assert.ok(read.ok);
  assert.equal(read.content, "A\n", "served from the immutable HEAD blob");
});

// ── failures + parsing ──────────────────────────────────────────────────────

test("snapshot: a non-git directory fails truthfully", async () => {
  const authority = createSourceSnapshotAuthority();
  const notARepo = repo();
  rmSync(join(notARepo, ".git"), { recursive: true, force: true });
  const result = await authority.capture({ repoPath: notARepo });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.failure.code, V2_SOURCE_FAILURE_CODES.notAGitRepository);
});

test("snapshot: reads outside the repository are refused", async () => {
  const { reader } = await capture(repo({ "src/a.ts": "A\n" }));
  for (const path of ["../escape.txt", "/etc/passwd", "src/../../escape"]) {
    const read = await reader.read(path);
    assert.equal(read.ok, false, `${path} was not refused`);
    assert.ok(!read.ok);
    assert.equal(read.reason, "outside_repository");
  }
});

test("porcelain: a rename record's ORIGINAL path is consumed, not mistaken for an entry", () => {
  // `R  new\0old\0` — a naive split would treat `old` as a second changed path.
  const parsed = parsePorcelain("R  src/new.ts\0src/old.ts\0 M src/other.ts\0");
  assert.deepEqual(parsed.map((p) => p.path), ["src/new.ts", "src/other.ts"]);
});

test("porcelain: untracked records are recognised by their double question mark", () => {
  const parsed = parsePorcelain("?? src/new.ts\0 M src/a.ts\0");
  assert.deepEqual(
    parsed.map((p) => `${p.index}${p.worktree} ${p.path}`),
    ["?? src/new.ts", " M src/a.ts"],
  );
});

// ── enumeration (V2-006B) ───────────────────────────────────────────────────

test("enumeration: list() is HEAD plus untracked, minus deletions", async () => {
  const r = repo({ "src/a.ts": "A\n", "src/b.ts": "B\n", "README.md": "R\n" });
  writeFiles(r, { "src/new.ts": "N\n" });
  rmSync(join(r, "src", "b.ts"));
  const { reader } = await capture(r);
  assert.deepEqual([...(await reader.list())], ["README.md", "src/a.ts", "src/new.ts"]);
});

test("enumeration: a file IGNORED by git is never listed", async () => {
  const r = repo({ "src/a.ts": "A\n", ".gitignore": "secret.txt\n" });
  writeFiles(r, { "secret.txt": "shh\n" });
  const { reader } = await capture(r);
  assert.equal((await reader.list()).includes("secret.txt"), false, "git's ignore rules are the exclusion policy");
});

test("enumeration: every listed path is actually READABLE through the snapshot", async () => {
  const r = repo({ "src/a.ts": "A\n", "docs/x.md": "X\n" });
  writeFiles(r, { "src/added.ts": "ADD\n", "src/a.ts": "A2\n" });
  const { reader } = await capture(r);
  for (const path of await reader.list()) {
    assert.ok((await reader.read(path)).ok, `listed but unreadable: ${path}`);
  }
});

test("enumeration: a file created AFTER capture is not discoverable", async () => {
  const r = repo({ "src/a.ts": "A\n" });
  const { reader } = await capture(r);
  writeFiles(r, { "src/appeared-later.ts": "LATER\n" });
  assert.equal((await reader.list()).includes("src/appeared-later.ts"), false, "a run is bound to the state it started from");
});

test("enumeration: list() is stable and sorted, and repeated calls agree", async () => {
  const { reader } = await capture(repo({ "z.ts": "Z\n", "a.ts": "A\n", "m/n.ts": "N\n" }));
  const first = await reader.list();
  assert.deepEqual([...first], [...first].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual([...(await reader.list())], [...first]);
});
