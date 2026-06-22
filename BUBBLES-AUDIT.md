# Bubbles Audit — ikbi Third-Pass Review

**Auditor:** Bubbles (meticulous subagent)  
**Date:** 2026-06-22  
**Scope:** Full codebase review after Claude Code (Opus) + Codex (GPT-5.5) audits  
**ikbi version:** live on port 18796, 2,438 tests passing  

---

## Summary

Two prior audits found and fixed 3 HIGH + 3 MEDIUM + 1 LOW issues. This third pass
found **3 HIGH, 4 MEDIUM, and 2 LOW** issues that BOTH auditors missed. The most
critical: **every `/ikbi/*` route (corrections, specs, job-cards) has zero authentication**,
meaning anyone on the network can approve corrections, execute job cards, and modify specs.
Additionally, the spec-execute endpoint returns false completion without doing real work,
and the refuter's semantic spec-match check (#7) never activates in production.

---

## HIGH-1: Zero Authentication on All `/ikbi/*` Routes

**Severity:** HIGH  
**Files:**
- `src/modules/correction-library/index.ts:46-126` (5 routes)
- `src/modules/spec-artifact/index.ts:54-149` (5 routes)
- `src/modules/job-cards/index.ts:30-125` (7 routes)

**What both auditors missed:** The `/api/*` task routes (build/fix/tasks) correctly
implement bearer-token auth via `apiAuth` preHandler (`src/server/tasks.ts:63-71,185`).
But the 17 routes across correction-library, spec-artifact, and job-cards are registered
via `registerRoutes()` which mounts them WITHOUT any auth hook. The `apiAuth` preHandler
is scoped to the tasks registrar's encapsulation context and does NOT leak to other modules.

**What the user actually experiences:** With `IKBI_API_TOKEN` set, the operator believes
the API is protected. But any network client can:
- `PATCH /ikbi/corrections/:id/approve` — approve corrections that change build behavior
- `DELETE /ikbi/corrections/:id` — delete corrections
- `POST /ikbi/job-cards` — create arbitrary job cards
- `DELETE /ikbi/job-cards/:id` — delete job cards
- `POST /ikbi/job-cards/:id/run` — **execute** job cards (triggers builds!)
- `POST /ikbi/spec/:id/execute` — trigger spec execution
- `PATCH /ikbi/spec/:id` — modify spec steps before execution

Correction approval is particularly dangerous: an approved correction SUPPRESSES refuter
findings and reclassifies verifier warnings, directly weakening the security gate.

**Fix:** Add the same `apiAuth` preHandler to every module's route registrar. Best approach:
extract `apiAuth` to a shared module (e.g., `server/auth.ts`) and apply it in each
`registerRoutes` callback, or add a server-level `addHook('preHandler', apiAuth)` in
`buildServer()` that covers all routes (with opt-out for health/ready).

---

## HIGH-2: Spec Execute Returns False Completion

**Severity:** HIGH  
**File:** `src/modules/spec-artifact/index.ts:120-148`

**What both auditors missed:** The `/ikbi/spec/:id/execute` endpoint marks a spec as
"completed" without executing ANY of its steps. The implementation is:

```typescript
for (const step of spec.steps) {
  outputs.push(`Step ${step.index}: ${step.goal} — received`);
}
const result = updateSpec(id, { status: "completed", output: outputs.join("\n") });
```

The spec goes from `draft` → `executing` → `completed` with output like
"Step 1: Add user model — received". No model is invoked, no code is written,
no build runs. The UI dashboard shows a green "completed" spec.

**What the user actually experiences:** An operator creates a spec via the dashboard,
clicks "execute", sees "completed" status with step outputs, and believes the work was
done. The actual target repository is untouched. This is a silent false-success that
could go undetected until someone checks the repo.

The prior Codex audit noted this as MEDIUM-3 ("Spec execution is a stub") but
classified it as expected/in-progress. Since the route actively reports "completed"
status (not "pending" or "not implemented"), this is a user-facing lie, not a stub.

**Fix:** Either:
1. Return 501 Not Implemented with a clear message, OR
2. Wire the execute endpoint to the task service to actually submit builds per step,
   OR
3. Set status to a new "not_implemented" state that the UI renders differently from
   "completed"

---

## HIGH-3: Refuter Semantic Spec-Match Check (#7) Never Activates

**Severity:** HIGH  
**Files:**
- `src/modules/worker-model/refuter.ts:461` (`semantic?: boolean`, defaults false)
- `src/modules/worker-model/orchestrator.ts:898-906` (`refuterFor()`)
- `src/modules/worker-model/refuter.ts:297-321` (check #7 implementation)

**What both auditors missed:** The refuter has NINE checks. Check #7
(`result_matches_spec`) is the semantic gate that verifies the diff actually satisfies
the stated goal. When `semantic: true` is passed to `createRefuter`, it invokes a
model to judge goal-alignment. Without it, check #7 falls through to a trivial
deterministic heuristic:

```typescript
// refuter.ts:306-319 — without semantic model:
} else if (input.diffText.trim().length > 0 && input.goal.trim().length > 0) {
  findings.push({
    check: "result_matches_spec",
    passed: true, // ← ALWAYS passes when there's any diff
    evidence: "spec match not semantically evaluated (no model verdict supplied)",
    severity: "info",
  });
}
```

The orchestrator's `refuterFor()` at line ~898-906 creates the refuter WITHOUT
`semantic: true`:

```typescript
return createRefuter({
  ...(workspaces.diff !== undefined ? { diff: ... } : {}),
  corrections: liveCorrectionAccess,
  // semantic is NOT set → defaults to false
});
```

**What the user actually experiences:** A builder can produce changes that are
completely unrelated to the goal (e.g., goal: "fix auth bug", builder: reformats
README), and the refuter's spec-match check will pass because there IS a diff. The
refuter's primary purpose — catching off-target builds — is neutered for the most
important check.

**Fix:** Wire `semantic: true` in `refuterFor()` when the refuter is enabled, or make
it configurable via `IKBI_REFUTER_SEMANTIC=true`. The model cost is bounded
(maxTokens: 512, temperature: 0.0).

---

## MEDIUM-1: No Auth on Receipts and Timeline Routes

**Severity:** MEDIUM  
**Files:**
- `src/server/receipts.ts:34-84`
- `src/server/timeline.ts` (full route)

**What both auditors missed:** The receipts (`GET /api/receipts`) and timeline
(`GET /api/timeline`) routes are registered via `registerRoutes` in their own
module-scope calls, NOT through `registerTaskRoutes` which applies the `apiAuth`
preHandler. They share the `/api/` URL prefix but NOT the auth guard.

**What the user actually experiences:** With `IKBI_API_TOKEN` set, the operator
believes all `/api/*` routes are protected. But anyone can read:
- Full build history (task IDs, goals, file changes, costs)
- Agent identities and trust tiers
- Success/failure patterns
- Cost breakdowns

This is information disclosure that aids reconnaissance for targeting the
unprotected write endpoints (HIGH-1).

**Fix:** Apply the same `apiAuth` preHandler (or a server-level hook) to these routes.

---

## MEDIUM-2: TOCTOU Race Conditions in File-Based Stores

**Severity:** MEDIUM  
**Files:**
- `src/modules/correction-library/store.ts:92-98` (approveCorrection)
- `src/modules/correction-library/store.ts:114-127` (recordApplication)
- `src/modules/spec-artifact/store.ts:80-87` (updateSpec)
- `src/modules/job-cards/store.ts:74-81` (updateCard)

**What both auditors missed:** Every store operation follows a non-atomic
read-modify-write pattern:

```typescript
const existing = readFileSync(path, "utf8");  // READ
const updated = { ...JSON.parse(existing), ...changes };  // MODIFY
writeFileSync(path, JSON.stringify(updated));  // WRITE
```

When two ikbi processes run simultaneously (the task API supports 3 concurrent
builds), two requests can:
1. Both read the same `appliedCount: 5`
2. Both compute `appliedCount: 6`
3. Last writer persists `6` — the first increment is lost

`recordApplication` is called during production builds (when a correction is applied),
so concurrent builds that match the same correction lose application counts. More
critically, `updateSpec`/`updateCard` can lose field merges from concurrent PATCH
requests.

**What the user actually experiences:** Correction `appliedCount` drifts lower than
reality. In theory, concurrent spec/job-card edits could lose fields. Low probability
but unfixable without locking.

**Fix:** Use `writeFileSync` with a temp file + rename (atomic on POSIX) for the write.
For true concurrent safety, use `flock` or a lightweight advisory lock. At minimum,
document that the file store is single-writer.

---

## MEDIUM-3: No Input Length Validation on Store-Backed Routes

**Severity:** MEDIUM  
**Files:**
- `src/modules/correction-library/index.ts:48-78` (POST body)
- `src/modules/spec-artifact/index.ts:56-83` (POST body)
- `src/modules/job-cards/index.ts:51-70` (POST body)

**What both auditors missed:** The POST handlers validate that fields are non-empty
strings but impose NO length limits. A malicious client can submit megabytes of text
in `finding`, `correction`, `regression`, `goal`, `name`, `goalTemplate`, etc. Each
request writes a JSON file to disk (`~/.ikbi/corrections/`, `~/.ikbi/specs/`,
`~/.ikbi/job-cards/`), consuming unbounded disk space.

**What the user actually experiences:** Disk exhaustion over time if the server is
exposed to untrusted clients (compounded by HIGH-1: no auth means anyone can do this).

**Fix:** Add `maxLength` constraints on string fields in the request body schemas
(e.g., 10KB per field), or use Fastify's `bodyLimit` config.

---

## MEDIUM-4: Correction Store Directory Deletion = Silent Data Loss

**Severity:** MEDIUM  
**Files:**
- `src/modules/correction-library/store.ts:81` (listCorrections returns [])
- `src/modules/correction-library/store.ts:51-69` (createCorrection recreates dir)

**What both auditors missed:** If `~/.ikbi/corrections/` is deleted (accidental `rm -rf`,
filesystem corruption, cleanup script), `listCorrections` silently returns `[]`. The
next `createCorrection` recreates the directory. All approved corrections — including
their `appliedCount` history and operator approval decisions — are permanently lost
with zero warning.

There is no:
- Startup integrity check (warn if store dir exists but is empty when it shouldn't be)
- Backup/export mechanism
- Immutability flag on approved corrections
- Event emission when corrections are lost

**What the user actually experiences:** After a directory deletion, every previously
suppressed refuter finding re-activates, every reclassified verifier warning goes back
to untrusted, and builds that previously succeeded may start failing — with no
explanation of what changed.

**Fix:** Add a startup check that logs a WARNING if the correction store was expected
but is missing/empty. Consider a write-ahead log or periodic export.

---

## LOW-1: Correction Route Tests Don't Exercise Auth (Coverage Gap)

**Severity:** LOW  
**Files:**
- `src/modules/correction-library/index.test.ts:302-427` (route tests)
- `src/server/tasks.test.ts:346-354` (task auth tests exist)

**What both auditors missed:** The task routes have auth tests (lines 346-354 in
tasks.test.ts verify 401 on bad bearer, 200 on correct bearer). The correction,
spec, and job-card route tests never test auth because there IS no auth. This means
the auth gap was invisible to test coverage — every route test passed because no auth
was required.

**Fix:** After adding auth (HIGH-1), add corresponding auth tests for all `/ikbi/*`
routes.

---

## LOW-2: Weak Default Guardrails on Job Card Creation

**Severity:** LOW  
**File:** `src/modules/job-cards/index.ts:57-67`

**What both auditors missed:** The `POST /ikbi/job-cards` handler defaults guardrails to
`{ maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false }` when the
caller omits them. A `maxFilesChanged: 0` means "no limit" (not "zero changes"). Combined
with HIGH-1 (no auth), anyone can create a job card with zero guardrails and execute it.

**Fix:** Either change the default `maxFilesChanged` to a reasonable limit (e.g., 20) or
make guardrails required.

---

## Cross-Cutting Observation: Auth Architecture

The root cause of HIGH-1, MEDIUM-1, and LOW-1 is that auth is implemented as a
per-registrar hook rather than a server-wide policy. The `registerRoutes` pattern
(each module registers independently) is excellent for modularity but creates a
foot-gun: every new module must remember to add auth. There is no server-level
"default deny" — the default is "open".

**Recommendation:** Add `app.addHook('preHandler', apiAuth)` at the server level in
`buildServer()`, with explicit opt-outs for public endpoints (`/health`, `/ready`,
`/agent`, `/capabilities`). This inverts the security model from "open unless guarded"
to "guarded unless public".
