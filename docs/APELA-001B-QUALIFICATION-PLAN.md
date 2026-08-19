# APELA-001B — Steam discovery (read-only): qualification plan

_Written in V2-020. **No Apela implementation exists yet and none is included in this commit.**
This is the plan for the first external task ikbi builds as the builder, rather than being built._

## Why this task

It is the smallest task that is still real: a read-only discovery module has genuine structure
(types, a client, parsing, error handling) but **no mutation, no credentials, no side effects**, so
a wrong answer is cheap and a right answer is verifiable by deterministic checks alone.

## Preconditions (all must hold before the run)

1. `pnpm build` green; full suite 0 failures.
2. `ikbi doctor --v2` reports **READY** — specifically the `governed-exec` line must name the
   target repo's real check commands as permitted (V2-020/Phase 20 makes this meaningful).
3. Target repository is a **clean git checkout** — v2 refuses to publish from a dirty source
   snapshot, and a dirty tree turns a refusal into a confusing failure.
4. The target's checks are **operator-declared** via `IKBI_CHECKS`, not inferred, so the exam is
   source-authorized and fixed before the builder sees the repo.

## The run

```
ikbi build "<goal>" \
  --repo <apela-repo> \
  --strategy single \
  --json > receipt.json
```

- **Single strategy first.** One candidate, one exam, one adjudication. Shadow/tournament multiply
  spend and add a selection question that is not what is being qualified here.
- **Cheap builder.** Set the builder tier to the cheap roster; the point is to prove the harness
  carries a modest model to a verified result, not to buy a good answer.
- **Deterministic checks only.** Typecheck plus unit tests over the discovery parsing. No network in
  the exam — fixture payloads, not live Steam calls, so the check is reproducible.
- **One attempt.** `IKBI_RECOVERY_MAX_ATTEMPTS=1` for the first run: a clean first-attempt signal is
  more informative than a recovered one.

## Exact receipt capture

Keep, verbatim, from `receipt.json`:

- `runId`, `buildSessionId`, `taskId`
- `receipt.stagesEntered` (all nine, or exactly where it stopped)
- `receipt.verification` — verdict, the checks that ran, `treeUnchanged`
- `receipt.critic` — verdict and any named defects
- `receipt.disposition` — the one lawful decision and its machine-readable reasons
- `receipt.promotion` — `beforeRef`, `afterRef`, `postCasVerified`, `worktreeSynced`, `stashed`
- `receipt.evidence.invocations` and the cost summary (known cost + any unknown-cost flag)
- the resulting commit SHA, and `git log`/`git diff` of the published change

## What counts as PASS

- Verification verdict `pass` on checks that genuinely exercise the new code (not a vacuous green).
- Disposition `acceptable_for_promotion` with a coherent critic verdict.
- Exactly one publication CAS; `postCasVerified: true`.
- The published tree is byte-identical to the candidate tree.

## What counts as an HONEST FAIL (also a successful qualification)

A withheld or rejected candidate with a truthful reason — red checks, critic defects, `no_checks` —
is a **good** outcome. It proves the harness refuses rather than fabricating a green. The failure
mode that would matter is a **false green**: a promotion whose checks did not actually test the
change.

## Explicitly out of scope

No Apela code in this commit. No writes to any Apela repository. No paid provider smoke unless
credentials are already present and the spend is intentionally tiny.
