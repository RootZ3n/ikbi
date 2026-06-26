# Failures & partials — 20260626-160049

## pg-20260626-160049-0002 — hostile-dirty-repo (FAIL)
- suite: hostile, mode: build
- notes: outcome=rejected, not promoted, no governance/structural reason (Refusing to build: target repo has uncommitted changes — commit or stash them first)
- files_changed: ["src/index.ts"]
- verification_kind: null
```

Build REJECTED — unknown
  Skipped: scout, builder, critic, verifier, integrator (not run)
  Reason: Refusing to build: target repo has uncommitted changes — commit or stash them first
  Changes: none (build did not reach the workspace stage)
  Undo available: no (build was not promoted)

Next:
  ikbi receipts --task build-1782507699639  — full audit trail for this run

```
