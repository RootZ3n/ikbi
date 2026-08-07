# ikbi release contract

This is the contract for the normal external-agent build workflow in the
release candidate. The supported path is:

```text
ikbi run --spec <task-file>
ikbi run --spec <task-file> --json
```

The task file is JSON. Its smallest useful form is:

```json
{
  "taskId": "calculator-fix",
  "goal": "Fix the calculator defect and keep the tests passing",
  "repository": "/absolute/path/to/repository"
}
```

`repository` is optional when `--repo <path-or-alias>` is supplied or the
current directory is the intended target. Optional fields are `branch`,
`checks` (an array of check command strings), `maxCostUsd`, `noTestsPolicy`,
and `rules` (an array of instructions included in the goal). `taskId` is
optional; ikbi derives a bounded identifier when it is absent.

Before any workspace is allocated or model is invoked, `run` reads and
validates the spec, resolves the repository and configuration, runs the same
local provider preflight as `doctor --check-providers`, checks Git/host/state/
receipt/workspace readiness, and refuses on any blocking condition. Provider
preflight is local-only: it never proves remote reachability and never calls a
provider.

When preflight passes, `run` delegates to the existing `createWorkerCli` build
handler, which delegates to `createProductionWorker` and
`createOrchestrator`. Workspace allocation, state-bound mutation, verification,
receipt creation, and promotion remain owned by those existing authorities.

The terminal JSON document has one bounded status (`completed`, `blocked`,
`failed`, or `cancelled`), a stable `runId`, the logical `taskId`, stable error
code, preflight report, workspace/candidate references, verification and
promotion status, paid-invocation and mutation flags, recovery instructions,
and direct evidence references. Incidental diagnostics go to stderr.

Exit status `0` means a completed, promoted run. Exit status `10` means a
local preflight block, `20` an execution failure, `30` cancellation, and `40`
an internal ikbi error. The JSON result is still emitted for every terminal
path. A verified candidate that was not promoted is not reported as a
successful build.
