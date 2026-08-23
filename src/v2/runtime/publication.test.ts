/**
 * PUBLICATION — REAL GIT PROOFS FOR THE ONE-REF-MUTATION INVARIANT (V2-019/HIGH-01).
 *
 * These tests drive `createCasPublicationTarget` against REAL disposable repositories and then
 * inspect REAL git state — `refs/heads/<branch>`, `HEAD`, the working tree, the index and the
 * stash list. A test that only asserted on the returned `PublicationOutcome` would have passed
 * against the defect these tests exist to pin: the outcome object was already correct while the
 * branch was being silently dragged backwards underneath it.
 *
 * THE INVARIANT. ikbi performs EXACTLY ONE authorized write to the target ref — the `update-ref`
 * CAS. After it returns, worktree reconciliation may touch the index, the working tree and the
 * stash, and NOTHING else. It may never move `refs/heads/<target>` again, so it can never
 * overwrite a concurrent actor's later publication.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { commitTree, revParse, runGit, syncWorktreeToCurrentHead, syncWorktreeToRef } from "../../core/workspace/git.js";
import { createCasPublicationTarget } from "./publication.js";
import type { PromotionTargetRef } from "../core/promotion.js";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A repository whose `target` branch is checked out in a LINKED worktree — the racy shape. */
async function makeRepo(): Promise<{ repo: string; worktree: string; base: string }> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-v2-pub-repo-"));
  dirs.push(repo);
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@ikbi.local"]);
  await runGit(repo, ["config", "user.name", "ikbi test"]);
  await writeFile(join(repo, "f.txt"), "base\n", "utf8");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-q", "-m", "base"]);
  await runGit(repo, ["branch", "target"]);
  const worktree = `${repo}-wt`;
  dirs.push(worktree);
  await runGit(repo, ["worktree", "add", "--quiet", worktree, "target"]);
  const base = await revParse(repo, "target");
  return { repo, worktree, base };
}

/** Build a commit carrying `content` in `f.txt`, parented on `parent`. Returns commit + tree. */
async function makeCommit(repo: string, parent: string, content: string, message: string): Promise<{ commit: string; tree: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "ikbi-v2-pub-idx-"));
  dirs.push(scratch);
  // Build the tree through a temporary index so the source checkout is never touched.
  const indexFile = join(scratch, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  await runGit(repo, ["read-tree", `${parent}^{tree}`], { env });
  await writeFile(join(scratch, "f.txt"), content, "utf8");
  const hash = (await runGit(repo, ["hash-object", "-w", join(scratch, "f.txt")], { env })).stdout.trim();
  await runGit(repo, ["update-index", "--add", "--cacheinfo", `100644,${hash},f.txt`], { env });
  const tree = (await runGit(repo, ["write-tree"], { env })).stdout.trim();
  const commit = await commitTree(repo, tree, [parent], message);
  return { commit, tree };
}

const targetRef = (repo: string, base: string): PromotionTargetRef & { baseCommit: string } => ({
  repositoryPath: repo,
  baseBranch: "target",
  baseCommit: base,
});

const stashCount = async (worktree: string): Promise<number> => {
  const list = (await runGit(worktree, ["stash", "list"])).stdout.trim();
  return list.length === 0 ? 0 : list.split("\n").length;
};

// ── A. NORMAL PUBLICATION ────────────────────────────────────────────────────

test("HIGH-01/A: a normal publication moves the ref ONCE and syncs the clean worktree to it", async () => {
  const { repo, worktree, base } = await makeRepo();
  const { tree } = await makeCommit(repo, base, "published\n", "candidate");
  const target = createCasPublicationTarget();

  const outcome = await target.publish({ target: targetRef(repo, base), expectedHead: base, candidateTreeId: tree, message: "publish" });

  assert.equal(outcome.kind, "landed");
  assert.ok(outcome.kind === "landed");
  assert.equal(outcome.worktreeSynced, true);
  assert.equal(outcome.postCas.verified, true);
  // NOTE (pre-existing, unchanged by HIGH-01): a checked-out target reports `stashed: true` even
  // with no user work, because the CAS moves HEAD out from under the checkout — index/working
  // tree still hold the OLD content, so `git status` is non-empty when the sync re-checks. This
  // held identically for the previous primitive; it is recorded here rather than silently
  // asserted away, and carried forward as a LOW note (a spurious stash, never lost work).
  assert.equal(outcome.stashed, true);
  // REAL git state, not the outcome object.
  assert.equal(await revParse(repo, "refs/heads/target"), outcome.afterCommit);
  assert.equal((await runGit(worktree, ["rev-parse", "HEAD"])).stdout.trim(), outcome.afterCommit);
  assert.equal((await runGit(worktree, ["status", "--porcelain"])).stdout.trim(), "", "index + working tree agree with HEAD");
  assert.equal(await readFile(join(worktree, "f.txt"), "utf8"), "published\n");
  assert.equal(await stashCount(worktree), 1, "the pre-CAS content is set aside — nothing is ever destroyed");
});

// ── B. LATE UNCOMMITTED WORK IS STASHED, NOT LOST ────────────────────────────

test("HIGH-01/B: late uncommitted work (tracked AND untracked) is stashed, never clobbered", async () => {
  const { repo, worktree, base } = await makeRepo();
  const { tree } = await makeCommit(repo, base, "published\n", "candidate");
  // Late work appears in the TOCTOU window between the cleanliness probe and the sync.
  await writeFile(join(worktree, "f.txt"), "base\nlate tracked edit\n", "utf8");
  await writeFile(join(worktree, "late-untracked.txt"), "precious\n", "utf8");

  const outcome = await createCasPublicationTarget().publish({ target: targetRef(repo, base), expectedHead: base, candidateTreeId: tree, message: "publish" });

  assert.ok(outcome.kind === "landed");
  assert.equal(outcome.stashed, true, "the stash fact is surfaced to the operator");
  assert.equal(outcome.worktreeSynced, true);
  assert.equal(await stashCount(worktree), 1);
  assert.equal((await runGit(worktree, ["status", "--porcelain"])).stdout.trim(), "");
  // The late work is recoverable, both halves of it.
  await runGit(worktree, ["stash", "pop", "--quiet"]);
  assert.match(await readFile(join(worktree, "f.txt"), "utf8"), /late tracked edit/);
  assert.equal(await readFile(join(worktree, "late-untracked.txt"), "utf8"), "precious\n");
});

// ── C / D. A CONCURRENT ADVANCE THE INSTANT THE CAS LANDS ────────────────────

/**
 * A DETERMINISTIC race seam, built out of real git rather than a stub: a `reference-transaction`
 * hook fires in the `committed` phase of every ref update. Installing one that advances the target
 * branch to `raceTo` the moment ikbi's own CAS commits reproduces, exactly and repeatably, the
 * window the defect lost data in — after the CAS, before the reprobe and the worktree sync. A
 * marker file makes it fire exactly once, so the hook's own update does not recurse.
 */
async function installPostCasRaceHook(repo: string, raceTo: string): Promise<void> {
  const commonDir = (await runGit(repo, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const hooks = join(repo, commonDir, "hooks");
  await mkdir(hooks, { recursive: true });
  const hook = join(hooks, "reference-transaction");
  await writeFile(
    hook,
    [
      "#!/bin/sh",
      '[ "$1" = "committed" ] || exit 0',
      'marker="$(git rev-parse --git-common-dir)/IKBI_RACED"',
      '[ -f "$marker" ] && exit 0',
      "while read -r old new ref; do",
      '  if [ "$ref" = "refs/heads/target" ]; then',
      '    : > "$marker"',
      `    git update-ref refs/heads/target ${raceTo}`,
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

test("HIGH-01/C+D: a concurrent advance the instant the CAS lands leaves C authoritative — NEVER ikbi's commit", async () => {
  const { repo, worktree, base } = await makeRepo();
  // C is a real competing publication, parented on the same base.
  const { commit: cCommit, tree: cTree } = await makeCommit(repo, base, "concurrent\n", "concurrent actor");
  const { tree: ikbiTree } = await makeCommit(repo, base, "ikbi\n", "candidate");
  await installPostCasRaceHook(repo, cCommit);

  const outcome = await createCasPublicationTarget().publish({
    target: targetRef(repo, base), expectedHead: base, candidateTreeId: ikbiTree, message: "publish",
  });

  // 1. THE PUBLICATION HAPPENED — it is not reported as an ordinary failure.
  assert.ok(outcome.kind === "landed" || outcome.kind === "landed_desynced", `expected a landed/degraded outcome, got ${outcome.kind}`);
  assert.notEqual(outcome.afterCommit, cCommit);

  // 2. THE AUTHORITATIVE REF IS C. This is the assertion the defect failed: the old primitive's
  //    `reset --hard <ikbiCommit>` dragged the branch BACKWARD over the concurrent publication.
  assert.equal(await revParse(repo, "refs/heads/target"), cCommit, "the concurrent publication is still the tip");
  assert.equal(await revParse(repo, "refs/heads/target^{tree}"), cTree);

  // 3. THE RESULT IS DEGRADED TRUTH, not a clean success — reconciliation is required.
  if (outcome.kind === "landed") {
    assert.equal(outcome.postCas.verified, false, "the fresh post-CAS reprobe no longer confirms our commit");
    assert.equal(outcome.worktreeSynced, false, "we did not sync the worktree to OUR commit — we never claim we did");
  }

  // 4. NO SECOND PUBLICATION, NO RETRY, NO RESTORE: our commit is not on the branch at all.
  const reachable = await runGit(repo, ["merge-base", "--is-ancestor", outcome.afterCommit, cCommit]).then(() => true).catch(() => false);
  assert.equal(reachable, false, "ikbi did not merge, re-CAS, or force its commit into the winning history");

  // 5. THE WORKTREE followed the ref it does not own, and is coherent — never forced back to I.
  assert.equal((await runGit(worktree, ["rev-parse", "HEAD"])).stdout.trim(), cCommit);
  assert.equal((await runGit(worktree, ["status", "--porcelain"])).stdout.trim(), "");
  assert.equal(await readFile(join(worktree, "f.txt"), "utf8"), "concurrent\n");
});

test("HIGH-01: the OLD primitive really did move the branch — this is why the new one exists", async () => {
  const { repo, worktree, base } = await makeRepo();
  const { commit: ikbiCommit } = await makeCommit(repo, base, "ikbi\n", "ikbi commit");
  const { commit: cCommit } = await makeCommit(repo, base, "concurrent\n", "concurrent actor");
  // The post-CAS world: ikbi landed I, then another actor advanced the branch to C.
  await runGit(repo, ["update-ref", "refs/heads/target", cCommit]);

  // THE DEFECT, reproduced against real git: an explicit-commit reset on a checked-out branch
  // moves that branch. This is a characterization test of the primitive publication no longer uses.
  await syncWorktreeToRef(worktree, ikbiCommit);
  assert.equal(await revParse(repo, "refs/heads/target"), ikbiCommit, "explicit-commit reset MOVES the checked-out branch (the defect)");

  // THE FIX: the ref-safe primitive synchronizes to whatever HEAD already is and moves nothing.
  await runGit(repo, ["update-ref", "refs/heads/target", cCommit]);
  const synced = await syncWorktreeToCurrentHead(worktree);
  assert.equal(synced.head, cCommit);
  assert.equal(await revParse(repo, "refs/heads/target"), cCommit, "the ref-safe primitive leaves the branch exactly where it found it");
  assert.equal((await runGit(worktree, ["status", "--porcelain"])).stdout.trim(), "");
});

// ── THE STATIC GUARD ─────────────────────────────────────────────────────────

test("HIGH-01 guard: after the CAS the publication adapter has NO path that can move the target ref", () => {
  const raw = readFileSync(fileURLToPath(new URL("./publication.ts", import.meta.url)), "utf8");
  // Scan CODE, not prose: the header comment names the forbidden primitive in order to explain
  // why it is forbidden, and a guard that tripped on its own documentation would be useless.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Everything after the ONE authorized CAS call.
  const casAt = src.indexOf("await updateRefCas(");
  assert.ok(casAt > 0, "the one authorized CAS must be present");
  const afterCas = src.slice(casAt + "await updateRefCas(".length);

  // Exactly ONE ref-moving CALL SITE exists in the whole adapter, and it is that CAS.
  assert.equal((src.match(/await updateRefCas\s*\(/g) ?? []).length, 1, "exactly one ref CAS call site in the adapter");
  assert.equal(afterCas.includes("updateRefCas("), false, "no second CAS after the ref moved");

  // The ref-moving sync primitive is neither imported nor called. `syncWorktreeToRef(path, commit)`
  // resets a CHECKED-OUT branch to an explicit commit, which moves that branch.
  assert.equal(/\bsyncWorktreeToRef\b/.test(src), false, "the explicit-commit sync primitive must not be reachable from publication");
  assert.ok(/\bsyncWorktreeToCurrentHead\b/.test(src), "worktree reconciliation goes through the ref-safe primitive");

  // No raw ref-writing git command is issued from this adapter at all.
  for (const forbidden of ["update-ref", "reset", "branch -f", "push", "symbolic-ref"]) {
    assert.equal(afterCas.includes(`"${forbidden}"`), false, `no raw \`git ${forbidden}\` after the CAS`);
  }
});

test("HIGH-01 guard: the ref-safe sync primitive passes NO commit argument to `git reset`", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../core/workspace/git.ts", import.meta.url)), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const fn = src.slice(src.indexOf("export async function syncWorktreeToCurrentHead"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.ok(body.includes('["reset", "--hard", "--quiet"]'), "a BARE reset — resets to HEAD, cannot move the branch");
  assert.equal(/\["reset",[^\]]*ref/.test(body), false, "no ref/commit argument may reach `git reset` here");
});
