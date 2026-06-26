# Failures & partials — 20260626-171331

## pg-20260626-171331-0015 — fix-noop-green (FAIL)
- suite: fix_mode, mode: fix
- notes: fix: could not resolve a doable repair
- files_changed: []
- verification_kind: null


## pg-20260626-171331-0040 — fix-env-missing (PARTIAL)
- suite: fix_mode, mode: fix
- notes: fix: ENVIRONMENT_MISSING
- files_changed: []
- verification_kind: null


## pg-20260626-171331-0041 — fix-noop-green (FAIL)
- suite: fix_mode, mode: fix
- notes: fix: could not resolve a doable repair
- files_changed: []
- verification_kind: null


## pg-20260626-171331-0059 — lang-rust-cli (FAIL)
- suite: language_builds, mode: build
- notes: outcome=rejected, not promoted, no governance/structural reason (discard: single-run build has no real test evidence (test evidence "zero"))
- files_changed: []
- verification_kind: null
```

Build REJECTED — unknown
  Reason: discard: single-run build has no real test evidence (test evidence "zero")
  Workspace: 378b3e5bf74a9d7f
  Changes: run `ikbi diff 378b3e5bf74a9d7f` to inspect
  Undo available: no (build was not promoted)

Next:
  ikbi diff 378b3e5bf74a9d7f                — inspect what changed
  ikbi workspace discard 378b3e5bf74a9d7f   — reclaim this workspace
  ikbi receipts --task build-1782516256575  — full audit trail for this run

```
