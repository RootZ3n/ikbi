# ikbi Safety Audit

Date: 2026-06-11

Scope reviewed:

- `src/core/workspace/manager.ts`
- `src/cli/undo.ts`
- `src/modules/gate-wall/`
- `src/modules/worker-model/verifier.ts`
- `src/modules/verification-ladder/`
- `src/core/receipt/`
- `src/core/trust/`
- model routing/capability files under `src/core/provider/capabilities.ts`, `src/modules/worker-model/role-models.ts`, `src/modules/worker-model/modes.ts`, `src/modules/cognition-layer/`, and `src/modules/agent-router/`
- safety-related modules found by name/content: `governed-exec`, `deterministic-judge`, `check-triage`, `egress`, `kill-switch`, injection neutralization, and relevant worker-model orchestration paths

Note: there is no `src/core/strict-build.ts`, `src/core/gate/`, `src/core/verifier/`, `src/core/truncation/`, or `src/core/cognitive-profiles/` directory in this repository. The corresponding behavior is implemented under modules: gate-wall, worker-model verifier, verification-ladder, provider capabilities, role-model routing, check-triage, and production mode resolution.

## Executive Summary

ikbi's safety design is centered on isolated git workspaces and fail-closed promotion. Model output does not directly touch the target branch. A build must pass a role pipeline, objective verification, integrator approval, and gate-wall governance before `WorkspaceManager.promote()` can move the target branch. Promotion itself is a single compare-and-swap git ref update after an intent record is durably written.

When a model makes a mistake before promotion, the target branch is not changed. Depending on configuration and manager capability, failed work is usually retained for inspection rather than discarded. After promotion, rollback exists through `ikbi undo`, which resets the target branch back to the receipt's recorded `beforeRef` only if the branch is still at the promoted `afterRef` and the checked-out worktree is clean. That makes undo reasonably safe for single-promotion rollback, but it is not a general history-rewrite recovery system.

The biggest residual risks are: model-driven critic/scout/cognition/router paths do not all fail on provider `finishReason: "length"` the way the builder does; receipts are operational logs without tamper evidence; undo relies on accurate promote receipts and local git state; egress has a documented DNS rebinding TOCTOU limitation; and an operator can explicitly opt out of hardened verification/retrieval paths.

## 1. When A Model Makes A Mistake, What Happens?

### Before promotion

The model works inside an isolated git worktree on a scratch branch. `WorkspaceManager.allocate()` writes an allocation intent before creating the worktree, then marks it allocated. The target repo branch is not changed during model editing.

The worker-model orchestrator runs roles in order: scout, builder, critic, verifier, integrator. The builder can write files only inside the workspace; it never promotes or discards. The critic is read-only. The verifier is deterministic and objective. The integrator only decides; it does not mutate lifecycle state.

If any role returns a non-success result, the orchestrator short-circuits. It does not call promote. For failed builds, current default behavior is to retain the workspace when possible (`retainFailedWorkspaces` defaults true) so the operator can inspect `ikbi diff <workspace-id>`. If retention is disabled or unavailable, it discards.

If a model produces bad code but all downstream gates catch it, the workspace is retained or discarded and the target branch is untouched.

### If the builder claims success incorrectly

The builder's own `done` tool is not a promote verdict. It is gated on:

- changed files must be read back;
- every written file must be included in `filesReadBack`;
- `run_checks` must have run;
- the last `run_checks` result must be green;
- check-triage treats parsed failures and zero-test runs as failures even when exit code is zero.

After that, the separate verifier runs. It is not model-driven. In production wiring it uses the hardened ladder by default and runs through governed-exec. The integrator only promotes if builder, critic, verifier, and policy status all line up.

### If the mistake slips past the pipeline

If the builder's mistake passes critic, verifier, integrator, and gate-wall, the workspace can be promoted. At that point the target branch is moved atomically to the new commit/ref. Recovery is then post-promotion undo or normal git recovery.

## 2. Is There A Rollback Mechanism After Promotion?

Yes, but it is intentionally narrow.

`WorkspaceManager.promote()` records a promote receipt with a state change:

- target: `<repo>#<branch>`
- before: `{ ref: beforeRef }`
- after: `{ ref: afterRef }`
- inverse: `git.update-ref` back to `beforeRef`

`ikbi undo <receipt-id|commit>` reads those receipts, locates a revertible promote, and performs:

1. Authenticated operator resolution using `IKBI_OPERATOR_TOKEN`.
2. Receipt lookup by receipt id or promoted commit.
3. Current branch check: the branch must still equal the recorded `afterRef`.
4. Checked-out worktree clean check.
5. CAS reset of `refs/heads/<branch>` from `afterRef` to `beforeRef`.
6. Worktree sync back to `beforeRef`, if checked out.
7. A new `workspace.undo` receipt that corrects the promote receipt.

This is safe against dropping later work because it refuses if the branch moved on. It is safe against clobbering local edits because it refuses dirty checked-out worktrees.

Limitations:

- It only reverts branch state recorded in promote receipts.
- It does not perform semantic revert/merge when later commits exist.
- It trusts the receipt log as operational data; receipts are not tamper-evident.
- If the branch is not checked out, it only moves the ref.

Crash reconciliation also exists: if a crash happens during promotion, a `promoting` record with before/after intent is reconciled on preload. If the target branch equals `afterRef`, the record becomes promoted and a receipt is recorded. Otherwise it reverts to allocated.

## 3. What Prevents A Bad Build From Reaching Master?

The promotion path has several independent gates:

1. Workspace isolation:
   Work happens in an isolated worktree and scratch branch. The target branch is not mutated until promote.

2. Identity and trust:
   Worker roles are spawned from a genuinely validated parent identity. Role trust is clamped so no role can outrank its parent. Trust state is MAC-protected and fails closed on unreadable or forged state.

3. Builder tool confinement:
   File tools are confined to the worktree. Tool results are neutralized as untrusted content before returning to the model. The builder cannot finish by bare stopping; it must call `done`.

4. Governed execution:
   Verification checks and builder `run_checks` use governed-exec in production wiring. Governed-exec requires a validated identity, default-denies unallowlisted binaries, forbids known eval/script bypass forms, gates through gate-wall, uses array args without a shell, scrubs env, and receipts outcomes.

5. Objective verification:
   The verifier is deterministic and does not call a model. It checks package script integrity before running checks. If it cannot inspect the diff, it fails closed as untrusted. In ladder mode, impact uncertainty escalates to full verification. Required-but-underivable full verification blocks instead of passing empty.

6. Check triage:
   Check output parsing treats exit code 0 as necessary but not sufficient. Parsed failures and zero-test runs fail closed.

7. Integrator fail-closed decision:
   Promotion requires builder success with files written, no rejected tool calls, critic pass, and verifier pass. Missing or malformed detail causes discard.

8. Gate-wall governance:
   Promotion requires gate-wall authorization. If gate-wall is absent, disabled, or the tier requires approval, promotion is denied. The workspace manager also refuses promotion unless `governance.allow === true`.

9. Atomic promote:
   Promotion computes merge state off-worktree and mutates only through a git compare-and-swap ref update. Merge conflicts return `promoted:false`; the target remains untouched.

10. Optional human approval:
   If wired, a human approval gate can reject promotion after verification and integrator approval.

## 4. Gaps Where A Bad Change Could Slip Through

1. Model-driven critic is still a subjective model gate.
   The critic can be wrong. The verifier is the stronger protection, but not all functional defects are caught by tests/typecheck.

2. Tests can be incomplete.
   The system hardens against vacuous greens, script rewrites, zero-test runs, and swallowed failures, but it cannot prove the test suite covers the requested behavior.

3. Truncation handling is uneven.
   Builder treats `finishReason: "length"` as non-success unless it already completed through validated `done`. However, scout, critic, cognition, and agent-router parse model content without a uniform hard failure on `finishReason: "length"` or `content_filter`. A truncated critic response could still parse as PASS if the first line says PASS.

4. Receipts are not tamper-evident.
   The receipt contract explicitly says receipts are operational logs, not a cryptographic ledger. Undo relies on promote receipts. An on-host actor with write access to the log can edit it.

5. Undo is branch-reset rollback, not semantic revert.
   Undo refuses moved branches. That protects later work but also means recovery after further commits requires manual git operations.

6. Egress DNS rebinding TOCTOU is documented.
   The egress guard resolves and validates IPs before passing the URL to fetch, but the underlying transport may resolve again at connect time. Static internal IP and simple rebinding answers are blocked; a race remains.

7. Operator opt-outs can reduce posture.
   `IKBI_VERIFY=legacy` and `IKBI_RETRIEVAL=legacy` are explicit opt-outs. Doctor reports this, but the system permits it.

8. Dependency installation is non-fatal.
   Dependency install failures are allowed to continue so builder/checks can surface them. This is pragmatic, but it means missing deps become later check failures rather than immediate stop.

9. Promotion receipt write is best-effort after promote.
   `recordPromoteReceipt()` catches and logs receipt failures. The branch can be promoted without a receipt if receipt append fails after the CAS. Workspace state still records promotion, but `ikbi undo` depends on the receipt trail.

## 5. Safeguards For Model Hallucination Or Wrong Code

Important safeguards:

- Builder prompt requires explicit success condition, read-before-write, read-back, checks, and `done`.
- Tool schemas and argument validation reject malformed tool calls.
- Path confinement prevents write/read escapes.
- Raw repo/tool/test/memory content is neutralized and marked untrusted.
- Builder `done` is gated on green `run_checks`.
- The builder's claim is not a verdict; verifier and integrator decide.
- Verifier is deterministic and model-free.
- Verification ladder escalates uncertainty to full checks.
- Script integrity guard rejects package script rewrites.
- Check-triage rejects zero tests and exit-swallowed failures.
- Integrator fails closed on missing detail or policy uncertainty.
- Deterministic judge in competitive mode disqualifies candidates with typecheck failure, test failure, or rejected tool calls before scoring.
- Role timeouts stop hung model/tool runs.
- Kill-switch checkpoints prevent new work and stop at role boundaries.
- Trust demotes failures/rejections and blocks auto-promotion after injection flags.

These controls are strong against common hallucination patterns: bogus claims of completion, invented test success, attempts to rewrite tests, path escapes, and untrusted content prompt injection.

They do not guarantee semantic correctness where tests and critic both miss the bug.

## 6. Is The Undo Command Actually Safe To Use?

After the fixes in this audit, yes for its intended scope.

Safety properties now present:

- It is no longer treated as a read-only info command in bootstrap.
- It no longer fabricates an operator identity.
- It requires resolving the configured operator token before reading receipts or mutating git.
- It only acts on promote receipts with before/after refs.
- It refuses if the branch has moved past the promoted commit.
- It refuses dirty checked-out worktrees.
- It performs a compare-and-swap ref update.
- It records a correction receipt after landing.

Residual caveats:

- It is a local git reset to a prior ref, not a semantic revert.
- It cannot undo after later work has landed without manual intervention.
- If the receipt log is tampered with or missing, undo may be unavailable or unsafe.
- If recording the undo receipt fails after the reset, the branch is reverted but the audit trail is incomplete; the command logs that failure.

Net: safe for immediate rollback of the last promoted receipt while the branch is still at that promotion. Not a general-purpose disaster recovery tool.

## 7. Other Safety Concerns

### Failed workspace retention is safer than discard, but needs operator hygiene

Retaining failed work prevents loss of useful debugging artifacts. `cleanOrphans()` now defaults `force:false`, and CLI clean preserves retained work unless `--force`. Operators still need to discard or force-clean retained work intentionally to avoid buildup.

### Promotion can land without receipt if receipt append fails

The promote CAS happens before receipt append. That is correct for atomic target mutation, but the receipt is best-effort. The workspace record remains durable, yet undo uses receipts, so a failed receipt append can weaken rollback discoverability.

### Gate-wall policy is simple

Gate-wall allow/deny is currently tier-based. It does not inspect action details beyond audit metadata. That is good for determinism, but the policy is coarse. Low-tier agents are denied because approval is not implemented; high-tier agents are allowed.

### Governed-exec default allowlist determines real verification viability

If the allowlist does not include the required package manager/check commands, verification fails closed. This protects safety but can produce operational friction.

### Legacy mode remains a footgun

Doctor reports legacy verification/retrieval, but hardening can be explicitly disabled. This is acceptable if treated as an operator override, not a normal production mode.

### Network guard limitation should remain visible

The egress module documents the DNS re-resolution race. Until fetch/transport supports pinned lookup/dispatcher behavior, this is a residual SSRF risk for allowed hostnames.

### Model output truncation should be centralized

The provider contract exposes `finishReason`, and builder handles length/content-filter as non-convergence. Other model consumers should adopt the same rule or a shared helper so truncated PASS/JSON outputs cannot be accepted.

## Bottom Line

ikbi's core safety posture is fail-closed before promotion and CAS-based after promotion. A bad model output normally dies in the workspace and either gets retained for inspection or discarded. A bad promoted change can be undone if the branch has not moved and the promote receipt is intact. The strongest protections are workspace isolation, deterministic verification, gate-wall governance, governed execution, script-integrity checks, and check-output triage.

The main remaining weaknesses are not in the atomic workspace mechanics; they are in coverage and auditability: tests can miss semantic bugs, model-driven reviewers can be wrong or truncated, receipts are not tamper-evident, and undo is intentionally narrow.
