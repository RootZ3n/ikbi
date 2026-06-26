# Failures & partials — 20260626-063936

## pg-20260626-063936-0006 — gov-read-confinement (INCOMPLETE)
- suite: governance, mode: build
- notes: no parseable JSON result (exit 1)
- files_changed: []
- verification_kind: null
```
ikbi: this goal decomposes into 2 steps, but the worker tier lacks autoCommit autonomy — intermediate steps never commit and the accumulated work would evaporate to "partial" (nothing lands). Grant the worker the "trusted" tier and re-run, or restate the goal so it runs as a single step.

```

## pg-20260626-063936-0007 — real-detect-ikbi (FAIL)
- suite: real_project, mode: cli
- notes: cli exit 0 or missing /typescript/
- files_changed: []
- verification_kind: null

