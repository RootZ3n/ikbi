#!/usr/bin/env bash

# Truthful test profiles for constrained environments.
#
# Each profile uses a unique state root and an awaited Node test process.  The
# order profile additionally sets test concurrency to one and runs both input
# orders, while every failed group is re-run file-by-file with the native test
# runner so its causal TAP error remains visible.  A suite whose required OS
# capability is unavailable is reported explicitly as NOT_RUN_UNSUPPORTED; it
# is never counted as a pass.

set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

PROFILE="${1:-deterministic}"
ORDER="${IKBI_TEST_ORDER:-normal}"
KEEP_LOGS="${IKBI_TEST_KEEP_LOGS:-false}"
TEST_CONCURRENCY=""
TEST_TIMEOUT_SECONDS="${IKBI_TEST_GROUP_TIMEOUT_SECONDS:-180}"
RUN_ROOT="$(mktemp -d /tmp/ikbi-test-runner.XXXXXX)"

cleanup() {
  if [[ "$KEEP_LOGS" != "true" ]]; then
    case "$RUN_ROOT" in
      /tmp/ikbi-test-runner.*) rm -rf -- "$RUN_ROOT" ;;
    esac
  else
    echo "# test runner logs preserved at $RUN_ROOT"
  fi
}
trap cleanup EXIT

doctor_shell="$(node --import tsx scripts/test-doctor.ts --shell 2>&1)"
doctor_status=$?
if [[ "$doctor_status" -ne 0 ]]; then
  echo "# test doctor failed; test execution is not classified safely"
  echo "$doctor_shell"
  exit 1
fi

CAP_SUBPROCESS=false
CAP_GIT=false
CAP_LOCALHOST_IPV4=false
CODE_SUBPROCESS=SUBPROCESS_UNSUPPORTED
CODE_GIT=GIT_CAPABILITY_UNSUPPORTED
CODE_LOCALHOST_IPV4=LOCALHOST_LISTEN_UNSUPPORTED

while IFS='=' read -r key value; do
  case "$key" in
    IKBI_CAP_SUBPROCESS) CAP_SUBPROCESS="$value" ;;
    IKBI_CAP_SUBPROCESS_CODE) CODE_SUBPROCESS="$value" ;;
    IKBI_CAP_GIT) CAP_GIT="$value" ;;
    IKBI_CAP_GIT_CODE) CODE_GIT="$value" ;;
    IKBI_CAP_LOCALHOST_IPV4) CAP_LOCALHOST_IPV4="$value" ;;
    IKBI_CAP_LOCALHOST_IPV4_CODE) CODE_LOCALHOST_IPV4="$value" ;;
  esac
done <<< "$doctor_shell"

GIT_SUITES=(
  "src/acceptance/verifier-target.test.ts"
  "src/modules/worker-model/checks-nonjs.test.ts"
  "src/modules/worker-model/critic-recovery-conformance.test.ts"
  "src/modules/worker-model/invocation-ledger-conformance.test.ts"
  "src/modules/worker-model/orchestrator.test.ts"
  "src/modules/worker-model/phase11b-lane-authority-conformance.test.ts"
  "src/modules/worker-model/phase11c-receipt-authority-conformance.test.ts"
  "src/modules/worker-model/phase12-semantic-substance-conformance.test.ts"
  "src/modules/worker-model/phase13-immutable-verification-conformance.test.ts"
  "src/modules/worker-model/phase13b-frozen-snapshot-conformance.test.ts"
  "src/modules/worker-model/phase13c-physical-snapshot-conformance.test.ts"
  "src/modules/worker-model/phase15-evidence-relevance-conformance.test.ts"
  "src/modules/worker-model/phase16-quarantine-conformance.test.ts"
  "src/modules/worker-model/promotion-authority-conformance.test.ts"
  "src/modules/worker-model/safety-evidence-conformance.test.ts"
)
SUBPROCESS_SUITES=(
  "src/acceptance/cli-smoke.test.ts"
  "src/v2/cli/cli-subprocess.test.ts"
  "src/v2/cli/config-truth.test.ts"
)
LOCALHOST_SUITES=("src/server/tasks.test.ts")

required_capability() {
  local file="$1"
  local item
  for item in "${GIT_SUITES[@]}"; do [[ "$file" == "$item" ]] && { echo git; return; }; done
  for item in "${SUBPROCESS_SUITES[@]}"; do [[ "$file" == "$item" ]] && { echo subprocess; return; }; done
  for item in "${LOCALHOST_SUITES[@]}"; do [[ "$file" == "$item" ]] && { echo localhost_ipv4; return; }; done
  echo none
}

all_files() {
  rg --files src -g '*.test.ts' | sort
}

capability_available() {
  case "$1" in
    git) [[ "$CAP_GIT" == "true" ]] ;;
    subprocess) [[ "$CAP_SUBPROCESS" == "true" ]] ;;
    localhost_ipv4) [[ "$CAP_LOCALHOST_IPV4" == "true" ]] ;;
    none) return 0 ;;
    *) return 1 ;;
  esac
}

capability_code() {
  case "$1" in
    git) echo "$CODE_GIT" ;;
    subprocess) echo "$CODE_SUBPROCESS" ;;
    localhost_ipv4) echo "$CODE_LOCALHOST_IPV4" ;;
    *) echo UNSUPPORTED ;;
  esac
}

build_file_list() {
  local mode="$1"
  local -n output="$2"
  output=()
  local -a candidates=()
  local file required

  if [[ "$mode" == "integration" ]]; then
    candidates=("${SUBPROCESS_SUITES[@]}" "${GIT_SUITES[@]}" "${LOCALHOST_SUITES[@]}")
  else
    mapfile -t candidates < <(all_files)
  fi

  for file in "${candidates[@]}"; do
    required="$(required_capability "$file")"
    if capability_available "$required"; then
      output+=("$file")
    else
      echo "# NOT_RUN_UNSUPPORTED suite=$file capability=$required code=$(capability_code "$required")"
    fi
  done

  if [[ "$ORDER" == "reverse" ]]; then
    local -a reversed=()
    local i
    for ((i=${#output[@]} - 1; i>=0; i--)); do reversed+=("${output[$i]}"); done
    output=("${reversed[@]}")
  fi
}

check_state_leaks() {
  local state_root="$1"
  local leaks
  leaks="$(find "$state_root" -type f -name '*.lock' -print 2>/dev/null || true)"
  if [[ -n "$leaks" ]]; then
    echo "# LEAK lock files remain under state root $state_root"
    echo "$leaks"
    return 1
  fi
  if jobs -pr | grep -q .; then
    echo "# LEAK awaited test process left a background shell job"
    jobs -pr
    return 1
  fi
  return 0
}

diagnose_file() {
  local file="$1"
  local index="$2"
  local state_root="$RUN_ROOT/causal-state-$index"
  local log="$RUN_ROOT/causal-$index.log"
  mkdir -p "$state_root"
  timeout --foreground --kill-after=10s 180s env \
    -u IKBI_OPERATOR_TOKEN -u IKBI_WORKER_TOKEN \
    IKBI_STATE_ROOT="$state_root" \
    IKBI_ALLOW_INSECURE_DEV_KEYS=true \
    IKBI_ENABLE_AUTONOMOUS_PROMOTION=true \
    IKBI_TEST_RUN_ID="causal-$index" \
    node --import tsx --test "$file" >"$log" 2>&1
  local status=$?
  echo "# causal diagnostic"
  echo "# suite=$file"
  echo "# command=env -u IKBI_OPERATOR_TOKEN -u IKBI_WORKER_TOKEN IKBI_STATE_ROOT=$state_root node --import tsx --test $file"
  echo "# exit=$status"
  echo "# workspace=$state_root"
  tail -n 180 "$log"
}

run_group() {
  local mode="$1"
  local -n suite_files="$2"
  local state_root="$RUN_ROOT/state-$mode-$ORDER"
  local log="$RUN_ROOT/group-$mode-$ORDER.log"
  local -a test_command=(node --import tsx --test)
  if [[ "$TEST_CONCURRENCY" == "1" ]]; then test_command+=(--test-concurrency=1); fi
  test_command+=("${suite_files[@]}")
  mkdir -p "$state_root"
  echo "# RUN group=$mode suites=${#suite_files[@]}"

  timeout --foreground --kill-after=10s "${TEST_TIMEOUT_SECONDS}s" env \
    -u IKBI_OPERATOR_TOKEN -u IKBI_WORKER_TOKEN \
    IKBI_STATE_ROOT="$state_root" \
    IKBI_ALLOW_INSECURE_DEV_KEYS=true \
    IKBI_ENABLE_AUTONOMOUS_PROMOTION=true \
    IKBI_TEST_RUN_ID="group-$mode-$ORDER" \
    "${test_command[@]}" >"$log" 2>&1
  local status=$?

  if [[ "$status" -ne 0 ]]; then
    echo "# FAIL group=$mode exit=$status workspace=$state_root log=$log"
    echo "# command=${test_command[*]}"
    tail -n 100 "$log"
    local -a failed_files=()
    mapfile -t failed_files < <(sed -nE 's/^not ok [0-9]+ - (src\/[^[:space:]]+\.test\.ts).*$/\1/p' "$log" | sort -u)
    local index=0
    local file
    if [[ "${#failed_files[@]}" -eq 0 ]]; then
      echo "# no individual suite name was recoverable from the bounded group output"
    else
      for file in "${failed_files[@]}"; do
        index=$((index + 1))
        diagnose_file "$file" "$mode-$ORDER-$index"
      done
    fi
    check_state_leaks "$state_root" || true
    return 1
  fi
  if ! check_state_leaks "$state_root"; then
    echo "# FAIL group=$mode cleanup=leak workspace=$state_root log=$log"
    tail -n 100 "$log"
    return 1
  fi
  echo "# node_test_summary"
  rg '^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) ' "$log" | tail -n 12
  echo "# PASS group=$mode suites=${#suite_files[@]}"
  return 0
}

run_profile() {
  local mode="$1"
  local -a files=()

  echo "# ikbi test profile=$mode order=$ORDER"
  echo "# capabilities subprocess=$CAP_SUBPROCESS git=$CAP_GIT localhost_ipv4=$CAP_LOCALHOST_IPV4"
  build_file_list "$mode" files
  local unsupported_count=$(( $(all_files | while read -r f; do [[ "$(required_capability "$f")" != none ]] && ! capability_available "$(required_capability "$f")" && echo x; done | wc -l) ))

  local failures=0
  if [[ "${#files[@]}" -gt 0 ]]; then
    if ! run_group "$mode" files; then failures=1; fi
  fi

  echo "# executed_test_files=${#files[@]} unsupported_environment_files=$unsupported_count failures=$failures"
  if [[ "$failures" -ne 0 ]]; then
    return 1
  fi
  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "# status=NOT_RUN_UNSUPPORTED (no executable suites for this profile)"
  else
    echo "# status=PASS_SUPPORTED (all executable suites passed; unsupported suites remain explicitly classified)"
  fi
  return 0
}

run_order() {
  TEST_CONCURRENCY=1
  TEST_TIMEOUT_SECONDS="${IKBI_TEST_ORDER_TIMEOUT_SECONDS:-600}"
  ORDER=normal
  run_profile deterministic || return 1
  ORDER=reverse
  run_profile deterministic || return 1
  echo "# status=PASS_SUPPORTED order=normal+reverse"
}

run_repeat() {
  local count=1
  local run
  for run in 1 2 3; do
    echo "# repeated canonical run=$run"
    ORDER=normal
    run_profile deterministic || return 1
    count=$run
  done
  echo "# status=PASS_SUPPORTED repeated_runs=$count"
}

case "$PROFILE" in
  deterministic) run_profile deterministic ;;
  integration) run_profile integration ;;
  full)
    run_profile deterministic && run_profile integration
    ;;
  order) run_order ;;
  repeat) run_repeat ;;
  *)
    echo "usage: $0 {deterministic|integration|full|order|repeat}" >&2
    exit 2
    ;;
esac
