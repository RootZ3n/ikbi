# Release-candidate acceptance record

Recorded 2026-08-06 on `state-bound-mutation-hardening`. This record is
deliberately limited to the release-hardening workflow; it is not a substitute
for the full Phase 1–5 authority suites.

## Preserved cold fixture

`/tmp/ikbi-cold-test` was recorded before acceptance as:

- branch: `master`;
- HEAD: `673ab3b Add calculator with deterministic defect (sum skips first element)`;
- status: `M src/calculator.ts`;
- HEAD contains the intentional `sum()` defect (`i = 1`), while the preserved
  working-tree change already had `i = 0`;
- `npm test` passes in the preserved working tree (one TAP suite containing
  the calculator assertions);
- `npm run typecheck` is not configured successfully because the fixture does
  not include Node type declarations; this is an existing fixture limitation;
- `src/calculator.ts` is expected to be modified by the historical fix.

The fixture was temporarily recreated at its clean defect state for the
provider/spec refusal checks, then restored to the recorded dirty fixed state.
No fixture commit, reset, stash, or normalization was performed.

## Reproducible checks

From the ikbi checkout:

```bash
pnpm build
pnpm test:release-candidate
```

The default acceptance script is non-billable and verifies missing-provider
refusal, invalid-spec refusal, exact JSON parsing, nested provider codes,
zero paid invocation, and the deterministic self-test. It prints the cold
fixture state before doing anything. Cases C/D require a capable Linux host
and explicit operator authorization; set `IKBI_ACCEPTANCE_REAL_RUN=1` only
when that host/provider setup is intentionally available. On this local
development-key setup, the reproducible command was:

```bash
IKBI_ACCEPTANCE_REAL_RUN=1 IKBI_ALLOW_INSECURE_DEV_KEYS=true \
  pnpm test:release-candidate
```

Use strong configured credentials instead of the development-key switch for
ordinary operation.

The default self-test never invokes a provider. An explicit
`ikbi self-test --provider-smoke` is available for a separately authorized,
bounded provider check and is not part of the non-billable acceptance script.

## Observed acceptance results on this host

- A missing DeepSeek/MiMo credential blocked with
  `RUN_PROVIDER_PREFLIGHT_BLOCKED`, nested `PROVIDER_CREDENTIAL_MISSING`
  causes, exit `10`, no workspace, no mutation, and no paid invocation.
- B invalid JSON spec blocked with `RUN_SPEC_INVALID`, exit `10`, before
  repository/provider/workspace work.
- `ikbi self-test --json` passed with zero provider calls, state-bound mutation,
  stale-mutation refusal, deterministic verification, receipt creation, and
  no orphan worktree/lock/temp state.
- On the capable host, provider preflight was ready and C passed the assertion
  that the canonical run left the preflight phases; it reached the existing
  authoritative build path. The latest run was
  `run-msi504ij-5317f5ceae`, with six invocation-ledger entries, a retained
  workspace, verification/promotion evidence, and a durable diagnostic path.
  This was the explicitly authorized paid path.
- On the capable host, D returned `FIXED_NARROWLY`, left `promoted: false`,
  passed both targeted and full checks, and removed the calculator defect in a
  disposable clone. The acceptance script completed with `release-candidate
  acceptance passed`; the original fixture was restored afterward. A bounded
  second attempt is allowed only when the first provider attempt left the
  defect untouched, preserving the state-bound refusal semantics.
- A restricted-shell rehearsal of C still correctly returns
  `RUN_HOST_CAPABILITY_MISSING` before workspace/provider work when bubblewrap
  is unavailable. This is the documented fail-closed behavior, not a provider
  or mutation failure.

## Fresh-project rehearsal

Disposable project: `/tmp/ikbi-next-project`, clean branch `main`, seed commit
`39280d6 rehearsal: ignore generated dependencies`. It contains a minimal
TypeScript package, a one-file greeting implementation/test, Node type
declarations, and a task spec requiring the implementation and test expansion.
The baseline `npm test` and `npm run typecheck` both pass.

Using the quickstart plus the target's normal `npm install` took about one
minute to the first authoritative terminal result on the capable host. The
final run used an explicit local development-key switch, made six provider
invocations, mutated two candidate files, passed verification, and returned
exit `10` / `RUN_PROMOTION_REFUSED` because autonomous promotion is disabled by
the existing governance default. The target remained clean. The retained
candidate was inspected with `ikbi inspect` and `ikbi diff`, which located 47
task/run-correlated receipts, six invocation-ledger entries, mutation and
verification/promotion receipts, the workspace path, and the durable diagnostic
bundle; it was then discarded through `ikbi workspace discard`. The candidate
diff contained the requested default/custom punctuation implementation and two
passing checks. No source inspection or undocumented ikbi repair was needed;
the development-key switch is now documented as a local-only exception.
