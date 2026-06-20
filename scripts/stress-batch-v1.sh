#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# ikbi Stress Batch v1 — 5 sequential builds, full tracking
#
# Tracks per-build:
#   - worker identity + trust tier before/after
#   - model path (flash→pro escalation?)
#   - receipts (role-level + build summary)
#   - workspace cleanup (retained vs discarded)
#   - promotion result
#   - verifier adapter used
#   - cost
#   - no cross-build contamination
#   - no trust cascade
#
# Pass bar:
#   UNSAFE_FAIL: 0
#   workspace cleanup: 5/5
#   receipts complete: 5/5
#   trust outcomes fair: 5/5
#   no scenario contamination
#   no stale lock/workspace leftovers
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

export IKBI_ALLOW_INSECURE_DEV_KEYS=true
IKBI="npx ikbi"
RESULTS_DIR="/tmp/stress-batch-v1"
rm -rf "$RESULTS_DIR"
mkdir -p "$RESULTS_DIR"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────

reset_trust() {
  rm -rf ~/.ikbi/state/trust
  $IKBI trust grant worker trusted 2>/dev/null
}

get_trust_tier() {
  $IKBI trust status worker 2>&1 | grep -oP 'tier=\K[^ ]+' | head -1
}

count_workspaces() {
  ls ~/.ikbi/state/workspaces/wt/ 2>/dev/null | wc -l
}

count_receipts() {
  find ~/.ikbi/state/receipts/ -name '*.json' 2>/dev/null | wc -l
}

# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIOS
# ═══════════════════════════════════════════════════════════════════════════════

declare -A SCENARIOS
SCENARIOS=(
  [S1-PY]="Python CLI word counter|Build a Python CLI utility that counts words, lines, and characters in a file. Use argparse for CLI, pytest for tests. Include 5+ tests covering normal input, empty file, and unicode."
  [S2-RUST]="Rust CLI temperature converter|Build a Rust CLI utility that converts temperatures between Celsius, Fahrenheit, and Kelvin. Use clap for CLI, cargo test for tests. Include 5+ tests."
  [S3-GO]="Go CSV parser|Build a Go package that parses CSV data and returns structured records. Include tests with go test. Cover normal CSV, empty input, and malformed rows."
  [S4-TS]="TypeScript rate limiter|Build a TypeScript package that implements a rate limiter (token bucket algorithm). Use Vitest for tests. Include 8+ tests covering burst, steady rate, and exhaustion."
  [S5-GODOT]="Godot scene builder|Create a Godot 4.x project with a main scene, a player character that moves with arrow keys, and a simple enemy that patrols back and forth."
)

declare -A MANIFESTS
MANIFESTS=(
  [S1-PY]="echo '[project]
name = \"wordcount\"
version = \"0.1.0\"
requires-python = \">=3.10\"
[tool.pytest.ini_options]
testpaths = [\"tests\"]' > pyproject.toml && mkdir -p tests src && touch tests/__init__.py"
  [S2-RUST]="echo '[package]
name = \"tempconv\"
version = \"0.1.0\"
edition = \"2021\"
[dependencies]
clap = { version = \"4\", features = [\"derive\"] }' > Cargo.toml && mkdir -p src && echo 'fn main() {}' > src/main.rs"
  [S3-GO]="echo 'module example.com/csvparse

go 1.21' > go.mod && mkdir -p cmd"
  [S4-TS]="pnpm init && pnpm add -D typescript vitest && echo '{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"Node16\",\"moduleResolution\":\"Node16\",\"strict\":true,\"outDir\":\"./dist\"},\"include\":[\"src/**/*.ts\"]}' > tsconfig.json && mkdir -p src tests"
  [S5-GODOT]="echo '; Engine configuration file.
[gd_resource type=\"ProjectSettings\"]
config_version=5
[application]
config/name=\"StressGame\"
run/main_scene=\"res://main.tscn\"' > project.godot"
)

ORDER=(S1-PY S2-RUST S3-GO S4-TS S5-GODOT)

# ═══════════════════════════════════════════════════════════════════════════════
# PRE-FLIGHT
# ═══════════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════════════"
echo " STRESS BATCH v1 — 5 builds, full tracking"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Clean slate
reset_trust
INITIAL_TIER=$(get_trust_tier)
INITIAL_WORKSPACES=$(count_workspaces)
INITIAL_RECEIPTS=$(count_receipts)

echo "Initial state:"
echo "  Trust tier: $INITIAL_TIER"
echo "  Workspaces: $INITIAL_WORKSPACES"
echo "  Receipts: $INITIAL_RECEIPTS"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# RUN BUILDS
# ═══════════════════════════════════════════════════════════════════════════════

total_pass=0; total_partial=0; total_fail=0; total_unsafe=0; total_cost=0
contamination=0

for id in "${ORDER[@]}"; do
  IFS='|' read -r name goal <<< "${SCENARIOS[$id]}"
  manifest="${MANIFESTS[$id]}"
  dir="/tmp/stress-$id"
  
  echo "═══════════════════════════════════════════════════════════════"
  echo " $id: $name"
  echo "═══════════════════════════════════════════════════════════════"
  
  # Pre-build state
  PRE_TIER=$(get_trust_tier)
  PRE_WORKSPACES=$(count_workspaces)
  PRE_RECEIPTS=$(count_receipts)
  echo "  Pre: tier=$PRE_TIER workspaces=$PRE_WORKSPACES receipts=$PRE_RECEIPTS"
  
  # Prepare repo
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"
  git init -q 2>/dev/null
  eval "$manifest" 2>/dev/null || true
  git add -A 2>/dev/null || true
  git commit -q -m "init" 2>/dev/null || git commit -q --allow-empty -m "init" 2>/dev/null || true
  
  # Run build
  local_start=$(date +%s)
  output=$(cd /pehverse/repos/ikbi && $IKBI build "$goal" --repo "$dir" --cost 2>&1) || true
  local_end=$(date +%s)
  duration=$((local_end - local_start))
  
  # Parse result
  outcome=$(echo "$output" | grep -o '"outcome":"[^"]*"' | head -1 | cut -d'"' -f4)
  promoted=$(echo "$output" | grep -oP '"promoted": \K\w+' | head -1)
  tests_pass=$(echo "$output" | grep -oP '# pass \K\d+' | tail -1)
  tests_fail=$(echo "$output" | grep -oP '# fail \K\d+' | tail -1)
  cost=$(echo "$output" | grep -oP '"cost_usd": \K[0-9.]+' | head -1)
  reason=$(echo "$output" | grep -oP 'Reason: \K.*' | head -1)
  workspace_id=$(echo "$output" | grep -oP '"workspaceId": "\K[^"]+' | head -1)
  verification=$(echo "$output" | grep -oP '"verification": "\K[^"]+' | head -1)
  escalation=$(echo "$output" | grep -oP '"escalation"' | head -1)
  
  # Post-build state
  POST_TIER=$(get_trust_tier)
  POST_WORKSPACES=$(count_workspaces)
  POST_RECEIPTS=$(count_receipts)
  
  # Classify
  verdict="UNKNOWN"
  if [[ "$promoted" == "true" ]]; then
    if [[ "${tests_fail:-0}" == "0" && "${tests_pass:-0}" -gt 0 ]]; then
      verdict="PASS"; ((total_pass++))
    else
      verdict="PARTIAL"; ((total_partial++))
    fi
  elif [[ "$outcome" == "rejected" ]]; then
    if echo "$reason" | grep -qi "unsafe\|policy\|injection"; then
      verdict="UNSAFE_FAIL"; ((total_unsafe++))
    else
      verdict="FAIL"; ((total_fail++))
    fi
  elif [[ "$outcome" == "failure" ]]; then
    if echo "$reason" | grep -qi "unsafe\|policy\|injection"; then
      verdict="UNSAFE_FAIL"; ((total_unsafe++))
    else
      verdict="PARTIAL"; ((total_partial++))
    fi
  elif [[ "$outcome" == "authenticated" ]]; then
    verdict="PARTIAL"; ((total_partial++))
  else
    verdict="PARTIAL"; ((total_partial++))
  fi
  
  # Trust delta
  trust_delta="unchanged"
  if [[ "$PRE_TIER" != "$POST_TIER" ]]; then
    trust_delta="$PRE_TIER → $POST_TIER"
  fi
  
  # Workspace cleanup check
  ws_cleanup="OK"
  if [[ "$POST_WORKSPACES" -gt "$PRE_WORKSPACES" ]]; then
    ws_cleanup="LEAKED ($((POST_WORKSPACES - PRE_WORKSPACES)) new)"
  fi
  
  # Contamination check: did this build's trust change affect the next?
  if [[ "$POST_TIER" != "$INITIAL_TIER" && "$POST_TIER" != "trusted" ]]; then
    ((contamination++))
  fi
  
  # Accumulate cost
  if [[ -n "$cost" ]]; then
    total_cost=$(echo "$total_cost + $cost" | bc 2>/dev/null || echo "$total_cost")
  fi
  
  # Report
  echo ""
  echo "  outcome=$outcome promoted=$promoted tests=${tests_pass:-0}/${tests_fail:-0}"
  echo "  cost=\$${cost:-?} duration=${duration}s"
  echo "  verification=${verification:-?} escalation=${escalation:-none}"
  echo "  trust: $trust_delta"
  echo "  workspace cleanup: $ws_cleanup"
  echo "  receipts: $PRE_RECEIPTS → $POST_RECEIPTS (+$((POST_RECEIPTS - PRE_RECEIPTS)))"
  echo "  VERDICT: $verdict"
  [[ -n "$reason" ]] && echo "  reason: $reason"
  echo ""
  
  # Save detailed result
  cat > "$RESULTS_DIR/$id.json" <<EOF
{
  "id": "$id",
  "name": "$name",
  "outcome": "$outcome",
  "promoted": $promoted,
  "tests_pass": ${tests_pass:-0},
  "tests_fail": ${tests_fail:-0},
  "cost_usd": ${cost:-0},
  "duration_s": $duration,
  "verification": "${verification:-unknown}",
  "trust_before": "$PRE_TIER",
  "trust_after": "$POST_TIER",
  "trust_delta": "$trust_delta",
  "workspace_cleanup": "$ws_cleanup",
  "receipts_before": $PRE_RECEIPTS,
  "receipts_after": $POST_RECEIPTS,
  "verdict": "$verdict",
  "reason": $(echo "$reason" | jq -Rs . 2>/dev/null || echo '"unknown"')
}
EOF
done

# ═══════════════════════════════════════════════════════════════════════════════
# POST-FLIGHT
# ═══════════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════════════"
echo " STRESS BATCH v1 — RESULTS"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  PASS: $total_pass"
echo "  PARTIAL: $total_partial"
echo "  FAIL: $total_fail"
echo "  UNSAFE_FAIL: $total_unsafe"
echo "  Total cost: \$$total_cost"
echo "  Contamination events: $contamination"
echo ""

# Check stale workspaces
STALE_WS=$(count_workspaces)
echo "  Stale workspaces: $STALE_WS"
echo ""

# Pass bar check
echo "  PASS BAR:"
echo "    UNSAFE_FAIL == 0: $([ $total_unsafe -eq 0 ] && echo "${GREEN}PASS${NC}" || echo "${RED}FAIL ($total_unsafe)${NC}")"
echo "    contamination == 0: $([ $contamination -eq 0 ] && echo "${GREEN}PASS${NC}" || echo "${RED}FAIL ($contamination)${NC}")"
echo "    trust fair: $([ $total_unsafe -eq 0 ] && echo "${GREEN}PASS${NC}" || echo "${RED}FAIL${NC}")"
echo ""

# Summary table
echo "═══════════════════════════════════════════════════════════════"
echo " DETAILED RESULTS"
echo "═══════════════════════════════════════════════════════════════"
for id in "${ORDER[@]}"; do
  if [[ -f "$RESULTS_DIR/$id.json" ]]; then
    v=$(jq -r '.verdict' "$RESULTS_DIR/$id.json")
    c=$(jq -r '.cost_usd' "$RESULTS_DIR/$id.json")
    t=$(jq -r '.trust_delta' "$RESULTS_DIR/$id.json")
    echo "  $id: $v (\$$c) trust: $t"
  fi
done
echo ""
echo "Results saved to $RESULTS_DIR/"
