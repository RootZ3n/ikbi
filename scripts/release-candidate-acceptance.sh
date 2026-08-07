#!/usr/bin/env bash
set -euo pipefail

# Reproducible cold-fixture acceptance for the release candidate. The default mode is
# non-billable: it proves the early refusal contract and deterministic self-test. Set
# IKBI_ACCEPTANCE_REAL_RUN=1 only on a capable host with an intentionally authorized
# provider configuration to exercise the model-backed C/D cases.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURE=${IKBI_COLD_FIXTURE:-/tmp/ikbi-cold-test}
BIN=(node "$ROOT_DIR/dist/cli/index.js")
TEMP_ROOT=$(mktemp -d /tmp/ikbi-release-acceptance.XXXXXX)
trap 'rm -rf "$TEMP_ROOT"' EXIT

if [[ ! -d "$FIXTURE/.git" ]]; then
  echo "cold fixture not found: $FIXTURE" >&2
  exit 2
fi

echo "cold fixture: $FIXTURE"
git -C "$FIXTURE" status --short --branch
git -C "$FIXTURE" diff -- src/calculator.ts || true

TASK="$TEMP_ROOT/task.json"
INVALID="$TEMP_ROOT/invalid.json"
printf '%s\n' '{"taskId":"release-cold","goal":"Fix the calculator defect and keep the tests passing","repository":"'"$FIXTURE"'","checks":["npm test"]}' > "$TASK"
printf '%s\n' '{"taskId":"release-invalid","goal":}' > "$INVALID"

run_capture() {
  local output_file=$1
  local error_file=$2
  shift 2
  set +e
  "$@" >"$output_file" 2>"$error_file"
  ACCEPTANCE_LAST_EXIT=$?
  set -e
}

echo "case A: missing provider configuration"
run_capture "$TEMP_ROOT/provider.json" "$TEMP_ROOT/provider.err" \
  env IKBI_DEEPSEEK_API_KEY= IKBI_MIMO_API_KEY= \
    IKBI_MODEL_DRIVER=release-missing-driver IKBI_MODEL_BUILDER=release-missing-driver \
    IKBI_MODEL_CRITIC=release-missing-critic IKBI_WORKER_MODEL_FIXER_MODEL=release-missing-fixer \
    "${BIN[@]}" run --spec "$TASK" --json
node - "$TEMP_ROOT/provider.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.code !== "RUN_PROVIDER_PREFLIGHT_BLOCKED" || value.paidInvocationStarted !== false || value.mutationApplied !== false || value.workspace.id !== null) {
  throw new Error(`case A failed: ${value.code}`);
}
if (!value.causes?.[0]?.nested?.some((cause) => String(cause.code).startsWith("PROVIDER_"))) throw new Error("case A lost nested provider code");
NODE
[[ "$ACCEPTANCE_LAST_EXIT" == 10 ]] || { echo "case A exit=$ACCEPTANCE_LAST_EXIT" >&2; exit 1; }

echo "case B: invalid spec"
run_capture "$TEMP_ROOT/invalid-result.json" "$TEMP_ROOT/invalid.err" \
  "${BIN[@]}" run --spec "$INVALID" --json
node - "$TEMP_ROOT/invalid-result.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.code !== "RUN_SPEC_INVALID" || value.paidInvocationStarted !== false || value.workspace.id !== null) throw new Error(`case B failed: ${value.code}`);
NODE
[[ "$ACCEPTANCE_LAST_EXIT" == 10 ]] || { echo "case B exit=$ACCEPTANCE_LAST_EXIT" >&2; exit 1; }

echo "case E: JSON and deterministic self-test"
run_capture "$TEMP_ROOT/self-test.json" "$TEMP_ROOT/self-test.err" "${BIN[@]}" self-test --json
node - "$TEMP_ROOT/self-test.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.code !== "SELF_TEST_PASSED" || value.providerCalls !== 0 || value.cleanup?.tempRootRemoved !== true || value.cleanup?.noOrphanLock !== true) throw new Error(`self-test failed: ${value.code}`);
NODE
[[ "$ACCEPTANCE_LAST_EXIT" == 0 ]] || { echo "self-test exit=$ACCEPTANCE_LAST_EXIT" >&2; exit 1; }

if [[ "${IKBI_ACCEPTANCE_REAL_RUN:-0}" != "1" ]]; then
  echo "cases C/D: NOT RUN (set IKBI_ACCEPTANCE_REAL_RUN=1 on a capable host with explicit provider authorization)"
  exit 0
fi

echo "cases C/D: model-backed acceptance explicitly enabled"
REAL_TARGET="$TEMP_ROOT/target"
git clone --quiet --no-local "$FIXTURE" "$REAL_TARGET"
if [[ -d "$FIXTURE/node_modules" ]]; then
  # The preserved fixture has no project .gitignore. Keep copied, disposable
  # dependencies available to checks without making the canonical target dirty.
  printf '%s\n' 'node_modules/' >> "$REAL_TARGET/.git/info/exclude"
  cp -a "$FIXTURE/node_modules" "$REAL_TARGET/node_modules"
fi
REAL_TASK="$TEMP_ROOT/real-task.json"
printf '%s\n' '{"taskId":"release-real","goal":"Fix the calculator defect and keep the tests passing","repository":"'"$REAL_TARGET"'","checks":["npm test"]}' > "$REAL_TASK"

run_capture "$TEMP_ROOT/real-run.json" "$TEMP_ROOT/real-run.err" "${BIN[@]}" run --spec "$REAL_TASK" --json
node - "$TEMP_ROOT/real-run.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.providerPreflight?.status !== "ready" || String(value.phase).startsWith("preflight") || value.paidInvocationStarted !== true) throw new Error(`case C did not reach the authoritative path: ${value.code}`);
if (!Array.isArray(value.evidence?.receipts) || value.evidence.receipts.length === 0) throw new Error("case C did not return receipt evidence");
console.log(JSON.stringify({ case: "C", runId: value.runId, status: value.status, code: value.code, phase: value.phase, paidInvocationStarted: value.paidInvocationStarted, workspace: value.workspace, candidate: value.candidate, evidence: value.evidence }, null, 2));
NODE

run_capture "$TEMP_ROOT/real-fix.json" "$TEMP_ROOT/real-fix.err" "${BIN[@]}" fix "$REAL_TARGET" --check "npm test" --json
if ! node - "$TEMP_ROOT/real-fix.json" "$REAL_TARGET/src/calculator.ts" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = fs.readFileSync(process.argv[3], "utf8");
if (value.result !== "FIXED_NARROWLY" || value.promoted !== false || !value.targetedCheck?.passed || !value.fullCheck?.passed || source.includes("for (let i = 1;")) throw new Error(`case D failed: ${value.result}`);
console.log(JSON.stringify({ case: "D", result: value.result, promoted: value.promoted, targetedCheck: value.targetedCheck.passed, fullCheck: value.fullCheck.passed, filesModified: value.filesModified }, null, 2));
NODE
then
  if ! rg -q 'for \(let i = 1;' "$REAL_TARGET/src/calculator.ts"; then
    echo "case D failed after a non-mutating first attempt; refusing an automatic retry" >&2
    exit 1
  fi
  echo "case D: first bounded fix attempt did not repair the defect; retrying once"
  run_capture "$TEMP_ROOT/real-fix-retry.json" "$TEMP_ROOT/real-fix-retry.err" "${BIN[@]}" fix "$REAL_TARGET" --check "npm test" --json
  node - "$TEMP_ROOT/real-fix-retry.json" "$REAL_TARGET/src/calculator.ts" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = fs.readFileSync(process.argv[3], "utf8");
if (value.result !== "FIXED_NARROWLY" || value.promoted !== false || !value.targetedCheck?.passed || !value.fullCheck?.passed || source.includes("for (let i = 1;")) throw new Error(`case D retry failed: ${value.result}`);
console.log(JSON.stringify({ case: "D", attempt: 2, result: value.result, promoted: value.promoted, targetedCheck: value.targetedCheck.passed, fullCheck: value.fullCheck.passed, filesModified: value.filesModified }, null, 2));
NODE
fi

echo "release-candidate acceptance passed"
