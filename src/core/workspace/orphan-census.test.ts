/**
 * THE ORPHAN CENSUS, against real git repositories (DD-02).
 *
 * Every fixture here builds an actual repo and an actual worktree, because the whole point of the
 * census is what GIT reports — `prunable`, `locked`, a registration that outlived its directory —
 * and a mock of git would only assert that the mock agrees with itself.
 *
 * The defect this closes: `cleanOrphans` found the repositories to sweep by walking the ikbi
 * workspace RECORD store, so a run whose state root was deleted left a registration and a scratch
 * branch that nothing ikbi could ever discover again. The canonical checkout accumulated 164
 * registrations and 165 namespace refs that way.
 *
 * The danger this closes: the pre-existing `reclaim()` force-deleted every non-live `ikbi/ws/*`
 * branch with `git branch -D` and no reachability check. Two branches in the canonical checkout
 * held commits reachable from nowhere else; that path would have destroyed both.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { SCRATCH_BRANCH_PREFIX } from "./contract.js";
import type { WorkspaceRecord } from "./contract.js";
import { applyCleanupPlan, authorizeCleanup, comparePruneEligibility, pruneEligibilityIsSafe, pruneEligibilityMatches, takeOrphanCensus, type CleanupStepOutcome } from "./orphan-census.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const git = (repo: string, ...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** A repo with one commit on `main`. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "ikbi-census-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "T");
  writeFileSync(join(d, "a.txt"), "one\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "base");
  return d;
}

/** Add a workspace worktree the way ikbi does, at `<root>/wt/<id>` on `ikbi/ws/<id>`. */
function addWorkspace(r: string, id: string, root?: string): { path: string; branch: string } {
  const base = root ?? mkdtempSync(join(tmpdir(), "ikbi-census-state-"));
  if (root === undefined) dirs.push(base);
  const path = join(base, "wt", id);
  mkdirSync(join(base, "wt"), { recursive: true });
  const branch = `${SCRATCH_BRANCH_PREFIX}${id}`;
  git(r, "worktree", "add", "-q", "-b", branch, path, "main");
  return { path, branch };
}

function record(r: string, id: string, path: string, branch: string, state = "allocated"): WorkspaceRecord {
  return {
    id, targetRepo: r, baseBranch: "main", baseRef: git(r, "rev-parse", "main"),
    scratchBranch: branch, path, identity: { agentId: "t", role: "builder" } as never,
    state: state as never, createdAt: 0, updatedAt: 0,
  } as WorkspaceRecord;
}

// ── the defect: a deleted state root must not hide the orphan ────────────────

test("DD-02: a registration whose STATE ROOT is gone is still discoverable with NO records", async () => {
  const r = repo();
  const { path, branch } = addWorkspace(r, "aaa1");
  rmSync(path, { recursive: true, force: true });     // the state root vanished
  git(r, "worktree", "list", "--porcelain");           // git still holds the registration

  // NO records at all — exactly the case `cleanOrphans` could never reach.
  const c = await takeOrphanCensus(r, []);
  const entry = c.worktrees.find((w) => w.path === path);
  assert.notEqual(entry, undefined, "the orphaned registration must be censused");
  assert.equal(entry?.record, "absent");
  assert.equal(entry?.registration, "missing_directory");
  assert.equal(entry?.ownership, "ikbi", "a worktree registration on a namespaced branch is ikbi's own");
  assert.equal(entry?.ownershipEvidence, "registration");
  assert.equal(entry?.action, "prune_registration");
  assert.ok(c.branches.some((b) => b.branch === branch), "its branch must be censused too");
});

// ── safety: what must never be removed ──────────────────────────────────────

test("DD-02: a LIVE worktree (directory present) is never proposed for removal", async () => {
  const r = repo();
  const { path, branch } = addWorkspace(r, "bbb1");
  const c = await takeOrphanCensus(r, []);
  const entry = c.worktrees.find((w) => w.path === path);
  assert.equal(entry?.registration, "live");
  assert.equal(entry?.action, "keep");
  const b = c.branches.find((x) => x.branch === branch);
  assert.equal(b?.action, "keep", "a branch a live worktree holds is never deleted");
  assert.equal(c.plan.length, 0, "a healthy repo produces an EMPTY plan");
});

test("DD-02: a LOCKED worktree is reported, never removed — even with its directory gone", async () => {
  const r = repo();
  const { path } = addWorkspace(r, "ccc1");
  git(r, "worktree", "lock", "--reason", "on removable media", path);
  rmSync(path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);
  const entry = c.worktrees.find((w) => w.path === path);
  assert.equal(entry?.registration, "locked");
  assert.equal(entry?.action, "report_only");
  assert.match(entry?.reasons.join(" ") ?? "", /LOCKED/);
  assert.equal(c.plan.filter((s) => s.target === path).length, 0, "a locked entry never enters the plan");
});

test("DD-02: a branch holding UNIQUE commits is reported, never deleted", async () => {
  const r = repo();
  const { path, branch } = addWorkspace(r, "ddd1");
  writeFileSync(join(path, "work.txt"), "the only copy\n");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "unique work nobody else has");
  const tip = git(r, "rev-parse", branch);
  git(r, "worktree", "remove", "--force", path);       // directory gone, branch remains

  const c = await takeOrphanCensus(r, []);
  const b = c.branches.find((x) => x.branch === branch);
  assert.equal(b?.uniqueCommits, 1, "the commit is reachable from no protected ref");
  assert.equal(b?.action, "report_only");
  assert.match(b?.reasons.join(" ") ?? "", /reachable from no other ref/);
  assert.equal(c.plan.filter((s) => s.kind === "delete_branch" && s.target === branch).length, 0);

  // And it really does survive an apply.
  await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(git(r, "rev-parse", branch), tip, "the ref still points at the unique commit");
});

test("DD-02: a FORGED ikbi-style branch (namespace only) is AMBIGUOUS and never deleted", async () => {
  const r = repo();
  git(r, "branch", `${SCRATCH_BRANCH_PREFIX}forged`, "main");   // no worktree, no record
  const c = await takeOrphanCensus(r, []);
  const b = c.branches.find((x) => x.branch === `${SCRATCH_BRANCH_PREFIX}forged`);
  assert.equal(b?.ownership, "ambiguous");
  assert.equal(b?.ownershipEvidence, "namespace_only");
  assert.equal(b?.action, "report_only");
  assert.equal(c.plan.length, 0, "ownership by NAME alone never authorizes a deletion");
});

test("DD-02: a NON-ikbi branch is outside the census's authority entirely", async () => {
  const r = repo();
  git(r, "branch", "feature/mine", "main");
  const c = await takeOrphanCensus(r, []);
  assert.equal(c.branches.find((x) => x.branch === "feature/mine"), undefined, "foreign branches are not namespace entries");
  assert.equal(c.plan.length, 0);
  assert.equal(git(r, "rev-parse", "--verify", "feature/mine").length, 40);
});

test("DD-02: the MAIN worktree is foreign to the census and always kept", async () => {
  const r = repo();
  const c = await takeOrphanCensus(r, []);
  const main = c.worktrees.find((w) => w.path === git(r, "rev-parse", "--show-toplevel"));
  assert.equal(main?.ownership, "foreign");
  assert.equal(main?.action, "keep");
});

// ── the plan: order, application, idempotence ───────────────────────────────

test("DD-02: registrations are pruned BEFORE branches are deleted", async () => {
  const r = repo();
  for (const id of ["eee1", "eee2"]) {
    const { path } = addWorkspace(r, id);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  const kinds = c.plan.map((s) => s.kind);
  const lastPrune = kinds.lastIndexOf("prune_registration");
  const firstDelete = kinds.indexOf("delete_branch");
  assert.ok(lastPrune >= 0 && firstDelete >= 0, `plan should hold both kinds: ${kinds.join(",")}`);
  assert.ok(lastPrune < firstDelete, "every prune must precede every branch deletion");
});

test("DD-02: applying the plan cleans the repo, and RE-applying is idempotent", async () => {
  const r = repo();
  const branches: string[] = [];
  for (const id of ["fff1", "fff2", "fff3"]) {
    const { path, branch } = addWorkspace(r, id);
    branches.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  const first = await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(first.failed, 0, JSON.stringify(first.outcomes, null, 1));
  for (const b of branches) {
    assert.equal(git(r, "branch", "--list", b), "", `${b} should be gone`);
  }
  assert.equal(git(r, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "only the main worktree remains");

  // A fresh census over the cleaned repo proposes nothing, and re-applying the OLD plan is a no-op.
  const after2 = await takeOrphanCensus(r, []);
  assert.equal(after2.plan.length, 0, "an already-clean repo yields an empty plan");
  const second = await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(second.failed, 0);
  assert.ok(second.outcomes.every((o) => o.outcome === "applied"), "already-gone targets count as applied, not failed");
});

test("DD-02: every step emits a receipt, including skips", async () => {
  const r = repo();
  const { path } = addWorkspace(r, "ggg1");
  rmSync(path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);
  const seen: CleanupStepOutcome[] = [];
  const app = await applyCleanupPlan(r, authorizeCleanup(c), { receipts: { record: (o) => void seen.push(o) } });
  assert.equal(seen.length, c.plan.length, "one receipt per planned step");
  assert.equal(seen.length, app.outcomes.length);
  assert.ok(seen.every((o) => o.detail.length > 0), "a receipt always says WHY");
});

// ── stale observations must not destroy live work ───────────────────────────

test("DD-02: a path RECREATED after the census is NOT pruned on the stale observation", async () => {
  const r = repo();
  const { path } = addWorkspace(r, "hhh1");
  rmSync(path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);
  assert.equal(c.plan.length > 0, true);

  // Between census and apply, the directory comes back — a new run legitimately owns this path.
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "live.txt"), "work in progress\n");

  const app = await applyCleanupPlan(r, { boundHead: c.boundHead, steps: c.plan.filter((s) => s.kind === "prune_registration") });
  const outcome = app.outcomes[0];
  assert.equal(outcome?.outcome, "skipped_changed", JSON.stringify(app.outcomes));
  assert.match(outcome?.detail ?? "", /EXISTS now/);
  assert.ok(existsSync(join(path, "live.txt")), "the recreated work must survive");
});

test("DD-02: a branch ADVANCED after the census is NOT deleted on the stale tip", async () => {
  const r = repo();
  const { path, branch } = addWorkspace(r, "iii1");
  const c = await takeOrphanCensus(r, []);
  // Census saw it as live+kept; force a plan that targets it, as a stale plan would.
  const stalePlan = [{ kind: "delete_branch" as const, target: branch, observed: { tip: git(r, "rev-parse", branch) }, reason: "stale" }];

  writeFileSync(join(path, "new.txt"), "new work\n");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "advanced after the census");

  const app = await applyCleanupPlan(r, { boundHead: git(r, "rev-parse", "HEAD"), steps: stalePlan });
  assert.equal(app.outcomes[0]?.outcome, "skipped_changed");
  assert.match(app.outcomes[0]?.detail ?? "", /moved since the census/);
  assert.equal(git(r, "branch", "--list", branch).replace(/[+*]/g, "").trim(), branch, "the branch survives");
  assert.equal(c.repositoryPath, r);
});

// ── records bind ownership more strongly than the namespace ──────────────────

test("DD-02: a record binds ownership even when the branch is outside the namespace", async () => {
  const r = repo();
  const d = mkdtempSync(join(tmpdir(), "ikbi-census-odd-"));
  dirs.push(d);
  const path = join(d, "wt");
  git(r, "worktree", "add", "-q", "-b", "odd/name", path, "main");
  const c = await takeOrphanCensus(r, [record(r, "odd", path, "odd/name")]);
  const entry = c.worktrees.find((w) => w.path === path);
  assert.equal(entry?.ownership, "ikbi");
  assert.equal(entry?.ownershipEvidence, "record");
  assert.equal(entry?.action, "keep", "its directory exists, so it is still never removed");
});

test("DD-02: the summary counts what the report will show", async () => {
  const r = repo();
  const live = addWorkspace(r, "jjj1");
  const dead = addWorkspace(r, "jjj2");
  rmSync(dead.path, { recursive: true, force: true });
  git(r, "branch", `${SCRATCH_BRANCH_PREFIX}forged2`, "main");

  const c = await takeOrphanCensus(r, []);
  assert.equal(c.summary.liveRegistrations >= 1, true);
  assert.equal(c.summary.missingDirectory, 1);
  assert.equal(c.summary.lockedRegistrations, 0);
  assert.equal(c.summary.namespaceBranches, 3, "two workspace branches plus the forged one");
  assert.equal(c.summary.ambiguous >= 1, true, "the forged branch is ambiguous");
  assert.equal(c.summary.prunableRegistrations, 1);
  assert.ok(c.protectedRefs.every((ref) => !ref.startsWith(`refs/heads/${SCRATCH_BRANCH_PREFIX}`)), "the namespace never protects itself");
  assert.ok(live.branch.startsWith(SCRATCH_BRANCH_PREFIX));
});

// ── concurrency ─────────────────────────────────────────────────────────────

test("DD-02: concurrent applies of the SAME plan do not double-delete or corrupt each other", async () => {
  const r = repo();
  const branches: string[] = [];
  for (const id of ["kkk1", "kkk2", "kkk3", "kkk4"]) {
    const { path, branch } = addWorkspace(r, id);
    branches.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  assert.ok(c.plan.length >= 8, `expected prunes + deletes, got ${c.plan.length}`);

  // Two workers racing the identical plan. Every step re-verifies, and an already-gone target
  // counts as applied, so the pair must converge rather than one of them erroring out.
  const [a, b] = await Promise.all([applyCleanupPlan(r, authorizeCleanup(c)), applyCleanupPlan(r, authorizeCleanup(c))]);
  assert.equal(a.failed, 0, JSON.stringify(a.outcomes.filter((o) => o.outcome === "failed"), null, 1));
  assert.equal(b.failed, 0, JSON.stringify(b.outcomes.filter((o) => o.outcome === "failed"), null, 1));
  for (const br of branches) assert.equal(git(r, "branch", "--list", br), "", `${br} should be gone`);
  assert.equal(git(r, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("DD-02: a census taken while another workspace is allocated still sees the live one as live", async () => {
  const r = repo();
  const dead = addWorkspace(r, "lll1");
  rmSync(dead.path, { recursive: true, force: true });
  const live = addWorkspace(r, "lll2");            // allocated concurrently, directory present

  const c = await takeOrphanCensus(r, []);
  const liveEntry = c.worktrees.find((w) => w.path === live.path);
  assert.equal(liveEntry?.action, "keep");
  assert.equal(c.plan.some((s) => s.target === live.path || s.target === live.branch), false,
    "a concurrently-live workspace must never enter the plan");

  await applyCleanupPlan(r, authorizeCleanup(c));
  assert.ok(existsSync(live.path), "the concurrent workspace survives the cleanup");
  assert.equal(git(r, "branch", "--list", live.branch).replace(/[+*]/g, "").trim(), live.branch);
  assert.equal(git(r, "branch", "--list", dead.branch), "", "the orphan was still reaped");
});

// ── the broad-prune gate ────────────────────────────────────────────────────

test("DD-02: a NEW orphan appearing after the census ABORTS the whole application", async () => {
  const r = repo();
  const planned: string[] = [];
  for (const id of ["mmm1", "mmm2"]) {
    const { path, branch } = addWorkspace(r, id);
    planned.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  assert.ok(c.plan.some((s) => s.kind === "prune_registration"));

  // Something else ran between approval and application — exactly what ikbi's own test suite
  // does to the canonical checkout — and left a fresh orphan the approval never covered.
  const late = addWorkspace(r, "mmm3");
  rmSync(late.path, { recursive: true, force: true });

  const app = await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(app.applied, 0, "nothing may be applied on a drifted approval");
  assert.equal(app.skipped, c.plan.length, "every step is refused, not just the prunes");
  assert.ok(app.outcomes.every((o) => o.outcome === "skipped_unsafe"));
  assert.match(app.outcomes[0]?.detail ?? "", /no longer matches the approved plan/);

  // Nothing was touched: the unreviewed orphan AND the approved ones all survive.
  assert.equal(git(r, "branch", "--list", late.branch).replace(/[+*]/g, "").trim(), late.branch);
  for (const b of planned) assert.equal(git(r, "branch", "--list", b).replace(/[+*]/g, "").trim(), b);
});

test("DD-02: comparePruneEligibility names added, missing and changed entries", async () => {
  const r = repo();
  const a = addWorkspace(r, "nnn1");
  rmSync(a.path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);

  // Identical repo ⇒ no drift.
  const same = await comparePruneEligibility(r, c.plan);
  assert.equal(pruneEligibilityMatches(same), true, JSON.stringify(same));

  // Add one ⇒ reported as added.
  const b = addWorkspace(r, "nnn2");
  rmSync(b.path, { recursive: true, force: true });
  const drifted = await comparePruneEligibility(r, c.plan);
  assert.equal(pruneEligibilityMatches(drifted), false);
  assert.equal(drifted.added.length, 1);
  assert.equal(drifted.added[0], b.path);

  // A plan naming a path git does not report prunable ⇒ reported as missing.
  const bogus = [{ kind: "prune_registration" as const, target: join(r, "no-such-worktree"), observed: { prunableReason: "x" }, reason: "stale" }];
  const missing = await comparePruneEligibility(r, bogus);
  assert.ok(missing.missing.includes(join(r, "no-such-worktree")));
  // MISSING alone is not drift: it shrinks what a repo-wide prune can touch, never expands it,
  // and a fully-applied plan leaves every target missing.
  assert.equal(pruneEligibilityIsSafe({ added: [], missing: ["/gone"], changed: [] }), true);
  assert.equal(pruneEligibilityMatches({ added: [], missing: ["/gone"], changed: [] }), false);
  assert.equal(pruneEligibilityIsSafe({ added: ["/new"], missing: [], changed: [] }), false);
  assert.equal(pruneEligibilityIsSafe({ added: [], missing: [], changed: [{ path: "/p", was: "a", now: "b" }] }), false);
});

test("DD-02: an unchanged repository applies the plan normally (the gate is not a blanket refusal)", async () => {
  const r = repo();
  const branches: string[] = [];
  for (const id of ["ooo1", "ooo2"]) {
    const { path, branch } = addWorkspace(r, id);
    branches.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  const app = await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(app.failed, 0, JSON.stringify(app.outcomes.filter((o) => o.outcome !== "applied"), null, 1));
  assert.equal(app.skipped, 0, "no drift ⇒ nothing withheld");
  for (const b of branches) assert.equal(git(r, "branch", "--list", b), "");
});

// ── HEAD binding: an approval names the repository state it approves ─────────

/** Every registration + ref, exactly as git reports them. Used to prove a refusal changed nothing. */
function repoIdentity(r: string): { worktrees: string; refs: string } {
  return {
    worktrees: git(r, "worktree", "list", "--porcelain"),
    refs: git(r, "for-each-ref", "--format=%(refname) %(objectname)"),
  };
}

/** Make a commit on `main` so HEAD moves, without touching any workspace branch. */
function advanceHead(r: string): string {
  writeFileSync(join(r, `moved-${Math.random().toString(36).slice(2)}.txt`), "later work\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "a commit made after the census");
  return git(r, "rev-parse", "HEAD");
}

test("DD-04: the census BINDS the HEAD it was taken at", async () => {
  const r = repo();
  const c = await takeOrphanCensus(r, []);
  assert.equal(c.boundHead, git(r, "rev-parse", "HEAD"));
  assert.match(c.boundHead, /^[0-9a-f]{40}$/, "a full object id, not an abbreviation");
  assert.equal(authorizeCleanup(c).boundHead, c.boundHead, "the authorization carries it through");
  assert.deepEqual(authorizeCleanup(c).steps, c.plan);
});

test("DD-04: a MATCHING HEAD preserves existing behavior exactly", async () => {
  const r = repo();
  const branches: string[] = [];
  for (const id of ["hb1", "hb2"]) {
    const { path, branch } = addWorkspace(r, id);
    branches.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  const app = await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(app.failed, 0, JSON.stringify(app.outcomes.filter((o) => o.outcome !== "applied"), null, 1));
  assert.equal(app.skipped, 0, "an unmoved repository is not refused");
  assert.equal(app.applied, c.plan.length);
  for (const b of branches) assert.equal(git(r, "branch", "--list", b), "", `${b} was cleaned`);
});

test("DD-04: a CHANGED HEAD refuses every action and mutates nothing", async () => {
  const r = repo();
  const branches: string[] = [];
  for (const id of ["hc1", "hc2", "hc3"]) {
    const { path, branch } = addWorkspace(r, id);
    branches.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  const auth = authorizeCleanup(c);
  assert.ok(auth.steps.length >= 6, "there is real work in the plan to refuse");

  // The repository moves AFTER the approval — the case the binding exists for.
  const movedTo = advanceHead(r);
  const before = repoIdentity(r);

  const app = await applyCleanupPlan(r, auth);
  assert.equal(app.applied, 0, "ZERO actions may be performed");
  assert.equal(app.failed, 0);
  assert.equal(app.skipped, auth.steps.length, "every proposed action is accounted for");
  assert.ok(app.outcomes.every((o) => o.outcome === "skipped_unsafe"), "and each as skipped_unsafe");

  const detail = app.outcomes[0]?.detail ?? "";
  assert.ok(detail.includes(c.boundHead), `the refusal names the EXPECTED head: ${detail}`);
  assert.ok(detail.includes(movedTo), `the refusal names the OBSERVED head: ${detail}`);

  const after = repoIdentity(r);
  assert.equal(after.worktrees, before.worktrees, "registrations are byte-identical");
  assert.equal(after.refs, before.refs, "refs are byte-identical");
  for (const b of branches) assert.equal(git(r, "branch", "--list", b).replace(/[+*]/g, "").trim(), b, `${b} survives`);
});

test("DD-04: a MISSING bound HEAD is rejected — never read as disabling the check", async () => {
  const r = repo();
  const { path } = addWorkspace(r, "hm1");
  rmSync(path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);
  const before = repoIdentity(r);

  // Every shape a caller might produce by forgetting the binding. None may be treated as
  // "the operator did not ask for a HEAD check".
  const bad: unknown[] = [
    { steps: c.plan },                                   // omitted
    { boundHead: undefined, steps: c.plan },             // explicitly undefined
    { boundHead: "", steps: c.plan },                    // empty
    { boundHead: null, steps: c.plan },                  // null
    { boundHead: c.boundHead.slice(0, 12), steps: c.plan }, // abbreviated — not a binding
    { boundHead: "not-a-sha", steps: c.plan },
  ];
  for (const auth of bad) {
    const app = await applyCleanupPlan(r, auth as never);
    assert.equal(app.applied, 0, `${JSON.stringify(auth)} must perform nothing`);
    assert.equal(app.skipped, c.plan.length, `${JSON.stringify(auth)} must account for every step`);
    assert.match(app.outcomes[0]?.detail ?? "", /no valid bound HEAD/, JSON.stringify(auth));
  }
  const after = repoIdentity(r);
  assert.equal(after.worktrees, before.worktrees);
  assert.equal(after.refs, before.refs);
});

test("DD-04: HEAD moving BETWEEN census and apply is caught even when the plan is still valid", async () => {
  const r = repo();
  const { path, branch } = addWorkspace(r, "hx1");
  rmSync(path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);
  // Nothing about the PLAN changes here — the same registration is still prunable and the same
  // branch still holds nothing unique. Only the repository state the approval described has moved.
  const drift = await comparePruneEligibility(r, c.plan);
  advanceHead(r);
  const stillNoDrift = await comparePruneEligibility(r, c.plan);
  assert.equal(pruneEligibilityMatches(stillNoDrift), true, "the prune gate alone would have allowed this");
  assert.equal(pruneEligibilityMatches(drift), true);

  const app = await applyCleanupPlan(r, authorizeCleanup(c));
  assert.equal(app.applied, 0, "the HEAD binding catches what the prune gate cannot see");
  assert.match(app.outcomes[0]?.detail ?? "", /moved since this cleanup was authorized/);
  assert.equal(git(r, "branch", "--list", branch).replace(/[+*]/g, "").trim(), branch);
});

test("DD-04: refusal is TOTAL — no step is applied before the barrier stops the rest", async () => {
  const r = repo();
  const branches: string[] = [];
  for (const id of ["hp1", "hp2", "hp3", "hp4"]) {
    const { path, branch } = addWorkspace(r, id);
    branches.push(branch);
    rmSync(path, { recursive: true, force: true });
  }
  const c = await takeOrphanCensus(r, []);
  const auth = authorizeCleanup(c);
  advanceHead(r);
  const before = repoIdentity(r);

  const app = await applyCleanupPlan(r, auth);
  // The barrier runs before ANY step, so there is no "first few applied then refused" state —
  // which is the outcome that would leave the operator unable to tell what happened.
  assert.equal(app.outcomes.filter((o) => o.outcome === "applied").length, 0);
  assert.equal(app.outcomes.length, auth.steps.length);
  assert.equal(repoIdentity(r).worktrees, before.worktrees, "not one registration was pruned");
  assert.equal(repoIdentity(r).refs, before.refs, "not one ref was deleted");
  for (const b of branches) assert.equal(git(r, "branch", "--list", b).replace(/[+*]/g, "").trim(), b);
});

test("DD-04: the HEAD check sits in the SAME barrier as the drift gate (both refuse, neither mutates)", async () => {
  const r = repo();
  const { path } = addWorkspace(r, "hd1");
  rmSync(path, { recursive: true, force: true });
  const c = await takeOrphanCensus(r, []);
  const auth = authorizeCleanup(c);

  // Both conditions violated at once: a new orphan AND a moved HEAD.
  const late = addWorkspace(r, "hd2");
  rmSync(late.path, { recursive: true, force: true });
  advanceHead(r);
  const before = repoIdentity(r);

  const app = await applyCleanupPlan(r, auth);
  assert.equal(app.applied, 0);
  assert.ok(app.outcomes.every((o) => o.outcome === "skipped_unsafe"));
  // HEAD is checked first because it is the cheapest and most fundamental question: is this even
  // the repository the approval describes?
  assert.match(app.outcomes[0]?.detail ?? "", /moved since this cleanup was authorized/);
  assert.equal(repoIdentity(r).refs, before.refs, "the unreviewed orphan survives too");
});
