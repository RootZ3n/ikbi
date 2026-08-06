import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino, type Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { DocumentStore } from "../substrate/store.js";
import { LockManager } from "../substrate/lock.js";
import {
  createWorkspaceMutation,
  MutationError,
  STALE_MUTATION,
  type MutationContext,
  type WorkspaceMutation,
} from "./mutation.js";
import { sha256Bytes } from "./file-state.js";
import type { WorkspaceRecord } from "./contract.js";
import { WorkspaceManager } from "./manager.js";
import { runGit } from "./git.js";

const silent: Logger = pino({ level: "silent" });
const IDENTITY: AgentIdentity = { agentId: "mutation-test", functionalRole: "builder", trustTier: "verified" };

interface Fixture {
  readonly repo: string;
  readonly root: string;
  readonly manager: WorkspaceManager;
  readonly workspaces: readonly Awaited<ReturnType<WorkspaceManager["allocate"]>>[];
}

let operationNumber = 0;

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-mutation-repo-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "mutation@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi mutation test"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}

async function makeFixture(workspaceCount = 1): Promise<Fixture> {
  const repo = await makeRepo();
  const root = join(tmpdir(), `ikbi-mutation-ws-${randomBytes(8).toString("hex")}`);
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 10_000, defaultStaleMs: 30_000 });
  const store = new DocumentStore<WorkspaceRecord>({
    dir: join(root, "registry"),
    locks,
    logger: silent,
    fsync: false,
  });
  const manager = new WorkspaceManager({ root, max: 32, locks, store, logger: silent });
  const workspaces = [];
  for (let i = 0; i < workspaceCount; i += 1) {
    workspaces.push(await manager.allocate({ targetRepo: repo, identity: IDENTITY }));
  }
  return { repo, root, manager, workspaces };
}

async function cleanup(fixture: Fixture): Promise<void> {
  for (const workspace of fixture.workspaces) {
    await fixture.manager.discard(workspace).catch(() => undefined);
  }
  await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  await rm(fixture.repo, { recursive: true, force: true }).catch(() => undefined);
}

function context(
  workspaceId: string,
  candidateId = "candidate-1",
  generationId = "generation-1",
): MutationContext {
  operationNumber += 1;
  return {
    workspaceId,
    candidateId,
    generationId,
    operationId: `mutation-operation-${operationNumber}`,
    actor: "human",
    cause: "human",
  };
}

function assertCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof MutationError);
  assert.equal(error.code, code);
  return true;
}

async function coreFor(fixture: Fixture, workspaceIndex = 0, locks?: LockManager): Promise<WorkspaceMutation> {
  const options = { lockFile: join(fixture.root, "candidate-mutation.lock") };
  if (locks !== undefined) return createWorkspaceMutation(fixture.workspaces[workspaceIndex]!, { ...options, locks });
  return createWorkspaceMutation(fixture.workspaces[workspaceIndex]!, options);
}

async function assertDiskProof(
  path: string,
  result: { readonly before: { readonly sha256: string | null; readonly byteLength: number | null }; readonly after: { readonly sha256: string | null; readonly byteLength: number | null } },
  beforeBytes: Buffer | null,
): Promise<void> {
  if (beforeBytes === null) {
    assert.equal(result.before.sha256, null);
    assert.equal(result.before.byteLength, null);
  } else {
    assert.equal(result.before.sha256, sha256Bytes(beforeBytes));
    assert.equal(result.before.byteLength, beforeBytes.byteLength);
  }
  const afterBytes = await readFile(path);
  assert.equal(result.after.sha256, sha256Bytes(afterBytes));
  assert.equal(result.after.byteLength, afterBytes.byteLength);
}

test("state-bound core successfully creates, replaces, deletes, and proves disk hashes", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    const path = join(workspace.path, "candidate.bin");
    const missing = await core.observe(context(workspace.id), "candidate.bin");
    assert.equal(missing.kind, "missing");
    assert.equal(missing.byteLength, null);
    assert.equal(missing.sha256, null);
    assert.equal(missing.bytes, null);

    const initial = Buffer.from([0, 1, 2, 255, 128, 0]);
    const created = await core.create(context(workspace.id), missing, initial);
    assert.equal(created.before.kind, "missing");
    assert.equal(created.after.kind, "regular");
    await assertDiskProof(path, created, null);
    assert.deepEqual(await readFile(path), initial);

    const observed = await core.observe(context(workspace.id), "candidate.bin");
    assert.deepEqual(Buffer.from(observed.bytes ?? Buffer.alloc(0)), initial);
    const replacement = await core.replace(
      context(workspace.id),
      observed,
      (observedBytes) => Buffer.concat([Buffer.from(observedBytes), Buffer.from([9, 10, 0, 255])]),
    );
    const expectedReplacement = Buffer.concat([initial, Buffer.from([9, 10, 0, 255])]);
    assert.equal(replacement.before.sha256, sha256Bytes(initial));
    assert.equal(replacement.after.sha256, sha256Bytes(expectedReplacement));
    await assertDiskProof(path, replacement, initial);
    assert.deepEqual(await readFile(path), expectedReplacement);

    const toDelete = await core.observe(context(workspace.id), "candidate.bin");
    const deleted = await core.delete(context(workspace.id), toDelete);
    assert.equal(deleted.before.sha256, sha256Bytes(expectedReplacement));
    assert.equal(deleted.before.byteLength, expectedReplacement.byteLength);
    assert.equal(deleted.after.kind, "missing");
    assert.equal(deleted.after.sha256, null);
    await assert.rejects(access(path));
  } finally {
    await cleanup(fixture);
  }
});

test("missing and empty files have distinct observations and empty bytes are retained", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    const path = join(workspace.path, "empty.txt");
    const missing = await core.observe(context(workspace.id), "empty.txt");
    const created = await core.create(context(workspace.id), missing, Buffer.alloc(0));
    assert.equal(created.after.kind, "empty");
    assert.equal(created.after.byteLength, 0);
    assert.equal(created.after.sha256, sha256Bytes(Buffer.alloc(0)));

    const empty = await core.observe(context(workspace.id), "empty.txt");
    assert.equal(empty.kind, "empty");
    assert.notEqual(empty.kind, missing.kind);
    assert.equal(empty.byteLength, 0);
    assert.equal(empty.sha256, sha256Bytes(Buffer.alloc(0)));
    assert.deepEqual(Buffer.from(empty.bytes ?? Buffer.from([1])), Buffer.alloc(0));

    const replaced = await core.replace(context(workspace.id), empty, (observed) => Buffer.from(observed));
    assert.equal(replaced.before.kind, "empty");
    assert.equal(replaced.after.kind, "empty");
    assert.deepEqual(await readFile(path), Buffer.alloc(0));
  } finally {
    await cleanup(fixture);
  }
});

test("stale content, including an unrelated changed byte, is rejected before writing", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    const path = join(workspace.path, "stale.txt");
    const original = Buffer.from("first line\nsecond line\n");
    const changed = Buffer.from("first line\nchanged elsewhere\n");
    await writeFile(path, original);
    const observed = await core.observe(context(workspace.id), "stale.txt");
    await writeFile(path, changed);

    await assert.rejects(
      core.replace(context(workspace.id), observed, Buffer.from("replacement\n")),
      (error: unknown) => assertCode(error, STALE_MUTATION),
    );
    assert.deepEqual(await readFile(path), changed, "a stale precondition must leave disk untouched");
  } finally {
    await cleanup(fixture);
  }
});

test("multi-file batches verify every precondition before any file changes", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    const firstPath = join(workspace.path, "batch-first.txt");
    const secondPath = join(workspace.path, "batch-second.txt");
    await writeFile(firstPath, "first before\n");
    await writeFile(secondPath, "second before\n");
    const firstObservation = await core.observe(context(workspace.id), "batch-first.txt");
    const secondObservation = await core.observe(context(workspace.id), "batch-second.txt");
    await writeFile(secondPath, "second changed independently\n");

    await assert.rejects(
      core.applyBatch(context(workspace.id), [
        { kind: "replace", path: "batch-first.txt", observation: firstObservation, content: Buffer.from("first after\n") },
        { kind: "replace", path: "batch-second.txt", observation: secondObservation, content: Buffer.from("second after\n") },
      ]),
      (error: unknown) => assertCode(error, STALE_MUTATION),
    );
    assert.deepEqual(await readFile(firstPath), Buffer.from("first before\n"));
    assert.deepEqual(await readFile(secondPath), Buffer.from("second changed independently\n"));

    const freshFirst = await core.observe(context(workspace.id), "batch-first.txt");
    const freshSecond = await core.observe(context(workspace.id), "batch-second.txt");
    const results = await core.applyBatch(context(workspace.id), [
      { kind: "replace", path: "batch-first.txt", observation: freshFirst, content: Buffer.from("first committed\n") },
      { kind: "replace", path: "batch-second.txt", observation: freshSecond, content: Buffer.from("second committed\n") },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.after.sha256, sha256Bytes(await readFile(firstPath)));
    assert.equal(results[1]!.after.sha256, sha256Bytes(await readFile(secondPath)));
  } finally {
    await cleanup(fixture);
  }
});

test("observations are bound to workspace and generation identity", async () => {
  const fixture = await makeFixture(2);
  try {
    const first = fixture.workspaces[0]!;
    const second = fixture.workspaces[1]!;
    const firstCore = await coreFor(fixture, 0);
    const secondCore = await coreFor(fixture, 1);
    await writeFile(join(first.path, "bound.txt"), "workspace one\n");
    const observation = await firstCore.observe(context(first.id), "bound.txt");

    await assert.rejects(
      secondCore.replace(context(second.id), observation, Buffer.from("wrong workspace\n")),
      (error: unknown) => assertCode(error, "MUTATION_VALIDATION"),
    );
    assert.deepEqual(await readFile(join(first.path, "bound.txt")), Buffer.from("workspace one\n"));

    await assert.rejects(
      firstCore.replace(context(first.id, "candidate-1", "generation-2"), observation, Buffer.from("wrong generation\n")),
      (error: unknown) => assertCode(error, "MUTATION_VALIDATION"),
    );
    assert.deepEqual(await readFile(join(first.path, "bound.txt")), Buffer.from("workspace one\n"));
  } finally {
    await cleanup(fixture);
  }
});

test("independent concurrent writers share the workspace lock and exactly one wins", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspaces[0]!;
    const firstLocks = new LockManager({ logger: silent, defaultTimeoutMs: 10_000, defaultStaleMs: 30_000 });
    const secondLocks = new LockManager({ logger: silent, defaultTimeoutMs: 10_000, defaultStaleMs: 30_000 });
    const firstCore = await coreFor(fixture, 0, firstLocks);
    const secondCore = await coreFor(fixture, 0, secondLocks);
    const path = join(workspace.path, "concurrent.txt");
    await writeFile(path, "base\n");
    const [firstObservation, secondObservation] = await Promise.all([
      firstCore.observe(context(workspace.id), "concurrent.txt"),
      secondCore.observe(context(workspace.id), "concurrent.txt"),
    ]);

    const results = await Promise.allSettled([
      firstCore.replace(context(workspace.id), firstObservation, Buffer.from("writer one\n")),
      secondCore.replace(context(workspace.id), secondObservation, Buffer.from("writer two\n")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assertCode(rejected[0]!.reason, STALE_MUTATION);
    const final = await readFile(path, "utf8");
    assert.ok(final === "writer one\n" || final === "writer two\n");
  } finally {
    await cleanup(fixture);
  }
});

test("symlink substitution is rejected and cannot redirect the mutation", async () => {
  const fixture = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), "ikbi-mutation-outside-"));
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    const target = join(workspace.path, "victim.txt");
    const outsideFile = join(outside, "outside.txt");
    await writeFile(target, "safe original\n");
    await writeFile(outsideFile, "outside original\n");
    const observation = await core.observe(context(workspace.id), "victim.txt");
    await unlink(target);
    await symlink(outsideFile, target);

    await assert.rejects(
      core.replace(context(workspace.id), observation, Buffer.from("must not land\n")),
      (error: unknown) => assertCode(error, "MUTATION_CONFINEMENT"),
    );
    assert.deepEqual(await readFile(outsideFile), Buffer.from("outside original\n"));
    assert.ok((await lstat(target)).isSymbolicLink());
  } finally {
    await cleanup(fixture);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("binary bytes and path escape attempts are handled without text coercion", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    const binary = Buffer.from([0, 255, 1, 2, 128, 10, 0, 254]);
    const path = join(workspace.path, "binary.dat");
    const missing = await core.observe(context(workspace.id), "binary.dat");
    const created = await core.create(context(workspace.id), missing, binary);
    assert.equal(created.after.sha256, sha256Bytes(binary));
    assert.deepEqual(await readFile(path), binary);

    const observed = await core.observe(context(workspace.id), "binary.dat");
    const inverted = await core.replace(context(workspace.id), observed, (bytes) =>
      Buffer.from(Uint8Array.from(bytes)).map((byte) => byte ^ 0xff));
    const expected = Buffer.from(binary).map((byte) => byte ^ 0xff);
    assert.equal(inverted.after.sha256, sha256Bytes(expected));
    assert.deepEqual(await readFile(path), expected);

    await assert.rejects(
      core.observe(context(workspace.id), "../escaped.txt"),
      (error: unknown) => assertCode(error, "MUTATION_CONFINEMENT"),
    );
    await assert.rejects(
      core.observe(context(workspace.id), path),
      (error: unknown) => assertCode(error, "MUTATION_CONFINEMENT"),
    );
  } finally {
    await cleanup(fixture);
  }
});

test("file observations distinguish directories and symlinks", async () => {
  const fixture = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), "ikbi-mutation-observe-outside-"));
  try {
    const workspace = fixture.workspaces[0]!;
    const core = await coreFor(fixture);
    await mkdir(join(workspace.path, "directory"));
    await writeFile(join(outside, "target.txt"), "target\n");
    await symlink(join(outside, "target.txt"), join(workspace.path, "link"));
    const directory = await core.observe(context(workspace.id), "directory");
    const link = await core.observe(context(workspace.id), "link");
    assert.equal(directory.kind, "directory");
    assert.equal(directory.sha256, null);
    assert.equal(link.kind, "symlink");
    assert.equal(link.symlinkTarget, join(outside, "target.txt"));
    assert.equal(link.sha256, sha256Bytes(Buffer.from(join(outside, "target.txt"))));
  } finally {
    await cleanup(fixture);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  }
});
