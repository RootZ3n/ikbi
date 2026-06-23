# GLM-5.2 Deep Audit — ikbi

Audit of the areas the three prior auditors touched, looking for what they ALL missed.
Each finding was verified by reading the source end-to-end and tracing the real data flow
through the orchestrator. Test gaps are noted where a passing test exists but does not
actually prove the contract.

---

## HIGH-1 — Refuter correction suppression is category-only: one approval blanket-disables a whole check class

**File:** `src/modules/worker-model/refuter.ts:479-515` (the match is at `refuter.ts:489-490`)

`applyCorrectionsToRefutation` suppresses a failed finding when its mapped category matches
an APPROVED correction's category:

```ts
const category = CHECK_TO_CATEGORY[f.check];
const match = category !== undefined ? byCategory.get(category)?.[0] : undefined;
```

The correction's `finding` text (the specific lesson the operator actually approved —
`CorrectionEntry.finding`, e.g. "assertions removed in auth.test.ts") is **never compared**
to the live finding's evidence. Matching is by category alone.

`CHECK_TO_CATEGORY` (`refuter.ts:378-388`) maps **two different checks onto the same
category** in several cases (`tests_actually_run` + `verification_real` →
`verification_forgery`; `source_matches_claims` + `result_matches_spec` →
`suspicious_pattern`), so a single approved correction suppresses multiple distinct checks.

**What the user experiences.** An operator approves ONE `test_weakening` correction for a
legitimate refactor in `auth.test.ts`. From that build on, a builder (which is untrusted)
can delete assertions from ANY test file in ANY build and the refuter silently marks
`tests_not_weakened` passed. The test-weakening gate is disabled project-wide. The same
holds for forgery/suspicious-pattern checks. This converts the HIGH-2 "corrections take
effect" fix into a fail-open regression the builder can exploit.

**Why the tests pass anyway.** `correction-application.test.ts:182-199` only asserts that a
MATCHING-category correction suppresses a finding. No test asserts that an UNRELATED
same-category correction (different file, different evidence) does NOT suppress. The
over-breadth is untested.

**Fix.** Scope suppression to the specific lesson: match the correction's `finding` against
the live finding's evidence (e.g. require the file/check id referenced in `finding` to
appear in `f.evidence`), or store an explicit `checkId`/`fileGlob` on `CorrectionEntry` and
require it to match. At minimum, do not collapse two semantically distinct checks onto one
category for suppression.

---

## HIGH-2 — Cross-role correction bleed: a `verification_forgery` correction silently weakens the VERIFIER's script-integrity guard

**File:** `src/modules/worker-model/verifier.ts:237-253` (the match is at `verifier.ts:247-249`)

`expectedManifestCorrection` reclassifies a flagged `package.json` script mutation as
EXPECTED when an approved correction exists in either of two categories:

```ts
const match = corrections
  .listApproved()
  .find((c) => c.category === "expected_manifest_change" || c.category === "verification_forgery");
```

But `verification_forgery` is the category the **refuter** files for `tests_actually_run`
and `verification_real` findings (`refuter.ts:379,383`) — findings about STUB/fake runners
and zero-test forgeries, i.e. the *opposite* of a stub→real-runner manifest upgrade. The
verifier's own comment (`verifier.ts:196-199`) claims the override is for
"expected_manifest_change / verification_forgery," but the semantic of `verification_forgery`
does not justify whitelisting a real-runner manifest mutation.

**What the user experiences.** The refuter files a `verification_forgery` proposal after a
refuted build. The operator approves it intending "stop nagging me about that one stub-runner
forgery." That same approval now causes the **verifier** (an unrelated gate) to stop
rejecting `package.json` test-script mutations in every future build (whenever the new value
is a real test runner). The operator's intent does not carry across roles, but the
correction does.

**Why the tests pass anyway.** `correction-application.test.ts:99-119` only exercises an
`expected_manifest_change` correction for the verifier. The `verification_forgery` branch of
the `||` is untested, so the cross-role bleed never surfaces.

**Fix.** In `expectedManifestCorrection`, match ONLY `c.category === "expected_manifest_change"`
(or introduce a dedicated verifier-side category). `verification_forgery` corrections are
refuter-scoped and must not alter the verifier's script-integrity guard.

---

## MEDIUM-1 — Correction/spec stores do read-modify-write with no locking: concurrent builds can clobber approvals

**Files:** `src/modules/correction-library/store.ts:92-99` (`approveCorrection`),
`store.ts:114-127` (`recordApplication`); `src/modules/spec-artifact/store.ts:80-87`
(`updateSpec`); production wiring `src/modules/worker-model/correction-application.ts:40-55`.

Each mutator does `readFileSync` → mutate object → `writeFileSync` with no lock. The
codebase ships a `substrate` module (atomic writes + locking — see CLAUDE.md) but these
stores use raw `writeFileSync`.

`liveCorrectionAccess` reads/writes the **shared** default `~/.ikbi/corrections/` dir, and
`proposeCorrection`/`approveCorrection` route handlers do too. Two concurrent `ikbi build`
runs (or competitive/tournament lanes) touch the same files.

**Concrete race.** `approveCorrection(id)` and `recordApplication(id)` on the same id:
- approve reads `{approved:false, appliedCount:0}`
- record reads `{approved:false, appliedCount:0}`
- approve writes `{approved:true,  appliedCount:0}`
- record writes `{approved:false, appliedCount:1}`  ← **approval reverted**

The operator believes a correction is in force; it was silently un-approved. Counter
increments are also lost under concurrent `recordApplication`.

**What the user experiences.** Intermittent, silent loss of an approved correction (a gate
the operator thought was suppressed re-arms, or vice-versa) and wrong `appliedCount`.
Hard to reproduce; looks like flake.

**Fix.** Route store mutations through `substrate`'s atomic write + lock, or use
`writeFileSync` to a temp path + `renameSync` (atomic on POSIX) and hold a per-id mutex
across the read-modify-write. The fix belongs in `store.ts` so every caller (routes,
`liveCorrectionAccess`, tests) is covered.

---

## MEDIUM-2 — Spec PATCH route has no field allowlist: state-machine bypass / forged completion

**File:** `src/modules/spec-artifact/index.ts:103-117`

```ts
app.patch("/ikbi/spec/:id", async (request, reply) => {
  const patch = request.body as Record<string, unknown>;
  ...
  const updated = updateSpec(id, patch as Parameters<typeof updateSpec>[1]);
  return updated;
});
```

The entire request body is forwarded to `updateSpec`. `updateSpec`
(`spec-artifact/store.ts:80`) accepts `Partial<Omit<SpecArtifact, "id" | "createdAt">>` —
i.e. **including `status`, `output`, `error`, `goal`, `steps`, `corrections`, `maxCostUsd`,
`maxFilesChanged`**. The only guard is `existing.status !== "draft"` → 400.

**What the user experiences.** An authenticated client can:
- `PATCH /ikbi/spec/:id {status:"completed", output:"done"}` — forge a completed spec
  without execution. Downstream consumers reading `status` are misled (this directly
  undermines the prior auditor's "execute returns not_implemented" fix, since completion can
  be forged by PATCH instead).
- `PATCH {status:"executing"}` — the execute route then returns 409 forever (DoS on the
  spec; only recoverable by another PATCH).
- Overwrite `goal`/`steps`/`corrections`/caps on a draft arbitrarily (the contract says
  PATCH is for "modify steps before execution," not the whole card).

**Fix.** Whitelist editable fields in the handler (e.g. `steps`, `goal`, and the
`SpecCardFields` set) and reject `status`/`output`/`error` explicitly. Status transitions
must only happen via the execute route.

---

## MEDIUM-3 — `fileRefuterCorrections` proposes corrections for non-critical (warning) findings, compounding HIGH-1

**File:** `src/modules/worker-model/orchestrator.ts:922-933`

```ts
for (const f of detail.findings as RefuterFinding[]) {
  if (f.passed) continue;
  proposeCorrection(proposalFromFinding(f, runId));
}
```

No severity filter. Warning-severity findings (`receipts_present`,
`manifest_change_expected` real→stub, `result_matches_spec` no-change) become PROPOSED
corrections. Once the operator approves one, HIGH-1's category-only matching
blanket-suppresses that entire check class for every future build.

**What the user experiences.** The refuter auto-files low-value "lesson" proposals for
warnings; approving any of them silently disables a whole check class (e.g. approving a
`receipts_present`-derived `environment_missing` correction suppresses all future
`receipts_present` warnings).

**Fix.** Only propose corrections for `severity === "critical"` findings (the ones that
actually refute). Warnings are operator-visible but not reusable lessons.

---

## LOW-1 — Spec execute route allows re-execution of terminal-status specs

**File:** `src/modules/spec-artifact/index.ts:120-150`

Only `spec.status === "executing"` returns 409. A `completed` / `failed` / `not_implemented`
spec can be re-executed: status resets to `executing`, then back to `not_implemented`.
Mostly harmless because execute is a dry-run, but it lets a client flip a `completed` spec
back to `not_implemented`, losing the terminal record.

**Fix.** Reject execution when `spec.status` is any terminal status
(`completed` / `failed` / `not_implemented`), or require an explicit reset step first.

---

## LOW-2 — Enabling `IKBI_API_TOKEN` makes the web UI at `/` return 401

**Files:** `src/server/auth.ts:18` (`PUBLIC_PREFIXES`), `src/server/index.ts:59,138-145`.

`PUBLIC_PREFIXES` is `["/health","/ready","/agent","/capabilities"]`. The static UI is
mounted at `/` via `fastifyStatic` (`index.ts:138-145`), and the server-level `preHandler`
(`index.ts:59`) applies to it. `/` is not in the public list, so when `IKBI_API_TOKEN` is
set, every UI asset returns 401. Browsers cannot attach a `Bearer` header to a navigated
page, so the UI is unreachable whenever auth is enabled.

**What the user experiences.** Setting `IKBI_API_TOKEN` (the recommended hardening) breaks
the web UI entirely.

**Fix.** Either serve the UI assets from a public prefix (and have the UI pass the token
via fetch for API calls), or extend `isPublicPath` to cover `GET` requests for static
asset extensions under `/`.

---

## LOW-3 — Store id is not sanitized against path traversal (defense-in-depth)

**Files:** `src/modules/correction-library/store.ts:31-33`,
`src/modules/spec-artifact/store.ts:19-21`.

`entryPath = join(storeDir, \`${id}.json\`)`. The route handlers pass `request.params.id`
straight in. Fastify's `:id` param does not match `/`, which mitigates most traversal, and
an id of `..` alone resolves to the harmless `...json` filename — but an encoded `..`
segment or future routing change could let a caller read/write outside the store dir.

**Fix.** Reject ids that are not UUID-like (or at least reject any id containing `/`, `\`,
or `..`) at the store boundary.

---

## Summary

The prior auditors wired the correction library into the production verifier/refuter and
made specs stop falsely reporting completion. What they missed is that the **suppression
semantics** they shipped are far too broad:

- the refuter matches corrections by **category only**, ignoring the specific `finding`
  the operator approved (HIGH-1);
- the verifier matches a category (`verification_forgery`) that is filed by the **refuter**
  for the opposite reason, so a refuter-scoped approval silently weakens the verifier
  (HIGH-2);
- the file-backing store mutations are non-atomic, so concurrent builds can silently
  un-approve a correction or lose counts (MEDIUM-1);
- the spec PATCH route forwards the whole body, letting a client forge `status:completed`
  and bypass the `not_implemented` fix the prior auditor just added (MEDIUM-2).

The common theme: the fixes were wired and unit-tested for the happy path, but the
**match granularity**, **cross-role scope**, **concurrency**, and **field-allowlist**
edge cases were not traced end-to-end. The existing tests pass but do not pin these
contracts.
