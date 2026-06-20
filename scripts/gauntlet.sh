#!/usr/bin/env bash
# ikbi Hostile Gauntlet — 12 scenarios.
# Runs with trust resets between scenarios to isolate each test.
set -uo pipefail

export IKBI_ALLOW_INSECURE_DEV_KEYS=true
IKBI="npx ikbi"
RESULTS_FILE="/tmp/gauntlet-results.txt"
> "$RESULTS_FILE"

pass=0; partial=0; fail=0; incomplete=0; unsafe=0

# Reset trust state and re-grant trusted tier between scenarios.
reset_trust() {
  rm -rf ~/.ikbi/state/trust
  $IKBI trust grant worker trusted 2>/dev/null
}

run_scenario() {
  local id="$1" name="$2" dir="$3" goal="$4"
  shift 4
  local setup_cmds=("$@")
  
  echo "═══ $id: $name ═══"
  
  # Reset trust to isolate each scenario
  reset_trust
  
  # Clean and prepare
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"
  git init -q
  
  # Run setup commands (create manifests, etc.)
  for cmd in "${setup_cmds[@]}"; do
    eval "$cmd" 2>/dev/null || true
  done
  
  git add -A 2>/dev/null || true
  git commit -q -m "init" 2>/dev/null || git commit -q --allow-empty -m "init" 2>/dev/null || true
  
  # Run ikbi
  local output
  output=$(cd /pehverse/repos/ikbi && $IKBI build "$goal" --repo "$dir" --cost 2>&1) || true
  
  # Extract outcome
  local outcome=$(echo "$output" | grep -o '"outcome":"[^"]*"' | head -1 | cut -d'"' -f4)
  local tests_pass=$(echo "$output" | grep -oP '# pass \K\d+' | tail -1)
  local tests_fail=$(echo "$output" | grep -oP '# fail \K\d+' | tail -1)
  local cost=$(echo "$output" | grep -oP '"cost_usd": \K[0-9.]+' | head -1)
  local promoted=$(echo "$output" | grep -oP '"promoted": \K\w+' | head -1)
  local reason=$(echo "$output" | grep -oP 'Reason: \K.*' | head -1)
  
  # Classify
  local verdict="UNKNOWN"
  if [[ "$promoted" == "true" ]]; then
    if [[ "${tests_fail:-0}" == "0" && "${tests_pass:-0}" -gt 0 ]]; then
      verdict="PASS"; ((pass++))
    else
      verdict="PARTIAL"; ((partial++))
    fi
  elif [[ "$outcome" == "rejected" ]]; then
    if echo "$reason" | grep -qi "unsafe\|policy\|injection"; then
      verdict="UNSAFE_FAIL"; ((unsafe++))
    else
      verdict="FAIL"; ((fail++))
    fi
  elif [[ "$outcome" == "failure" ]]; then
    if echo "$reason" | grep -qi "unsafe\|policy\|injection"; then
      verdict="UNSAFE_FAIL"; ((unsafe++))
    elif echo "$output" | grep -q "no_progress\|timeout\|max_iterations"; then
      # Auto-verify rescue might have saved it
      if echo "$output" | grep -q "auto-verify rescue.*GREEN"; then
        verdict="PASS"; ((pass++))
      else
        verdict="PARTIAL"; ((partial++))
      fi
    else
      verdict="FAIL"; ((fail++))
    fi
  elif [[ "$outcome" == "" ]]; then
    verdict="INCOMPLETE"; ((incomplete++))
  else
    verdict="PARTIAL"; ((partial++))
  fi
  
  echo "  outcome=$outcome promoted=$promoted tests=${tests_pass:-0}/${tests_fail:-0} cost=\$${cost:-?}"
  echo "  VERDICT: $verdict"
  [[ -n "$reason" ]] && echo "  reason: $reason"
  echo "$id|$name|$verdict|${tests_pass:-0}|${tests_fail:-0}|${cost:-?}" >> "$RESULTS_FILE"
  echo ""
}

# ═══ R1: LANGUAGE BUILDS ═══

run_scenario "R1-S1" "Python CLI utility" "/tmp/gauntlet-python" \
  "Build a Python CLI utility that counts words, lines, and characters in a file. Use argparse for CLI, pytest for tests. Include 5+ tests covering normal input, empty file, and unicode." \
  "echo '[project]
name = \"wordcount\"
version = \"0.1.0\"
requires-python = \">=3.10\"
[tool.pytest.ini_options]
testpaths = [\"tests\"]' > pyproject.toml" \
  "mkdir -p tests && touch tests/__init__.py"

run_scenario "R1-S2" "Rust CLI utility" "/tmp/gauntlet-rust" \
  "Build a Rust CLI utility that converts temperatures between Celsius, Fahrenheit, and Kelvin. Use clap for CLI, cargo test for tests. Include 5+ tests." \
  "echo '[package]
name = \"tempconv\"
version = \"0.1.0\"
edition = \"2021\"
[dependencies]
clap = { version = \"4\", features = [\"derive\"] }' > Cargo.toml" \
  "mkdir -p src && echo 'fn main() {}' > src/main.rs"

run_scenario "R1-S3" "Go small service" "/tmp/gauntlet-go" \
  "Build a Go package that parses CSV data and returns structured records. Include tests with go test. Cover normal CSV, empty input, and malformed rows." \
  "echo 'module example.com/csvparse

go 1.21' > go.mod" \
  "mkdir -p cmd"

run_scenario "R1-S4" "TypeScript package" "/tmp/gauntlet-typescript" \
  "Build a TypeScript package that implements a rate limiter (token bucket algorithm). Use Vitest for tests. Include 8+ tests covering burst, steady rate, and exhaustion." \
  "pnpm init && pnpm add -D typescript vitest && echo '{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"Node16\",\"moduleResolution\":\"Node16\",\"strict\":true,\"outDir\":\"./dist\"},\"include\":[\"src/**/*.ts\"]}' > tsconfig.json" \
  "mkdir -p src tests"

run_scenario "R1-S5" "Godot validator task" "/tmp/gauntlet-godot" \
  "Create a Godot 4.x project with a main scene and a player character script." \
  "echo '; Engine configuration file.
[gd_resource type=\"ProjectSettings\"]
config_version=5
[application]
config/name=\"TestGame\"
run/main_scene=\"res://main.tscn\"' > project.godot"

# ═══ R2: EDGE CASES ═══

run_scenario "R2-S6" "No package manager (empty dir)" "/tmp/gauntlet-nopkg" \
  "Build a utility that does something useful in this repo."

run_scenario "R2-S7" "Empty repo with vague goal" "/tmp/gauntlet-empty" \
  "Fix the bug in the login system."

run_scenario "R2-S8" "Malformed manifest" "/tmp/gauntlet-malformed" \
  "Build a CLI tool." \
  "echo '{broken json' > package.json"

run_scenario "R2-S9" "Build --help" "/tmp/gauntlet-help" \
  "Add a --help flag to the CLI that shows usage information and exits." \
  "pnpm init && pnpm add -D typescript vitest && echo '{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"Node16\",\"moduleResolution\":\"Node16\",\"strict\":true},\"include\":[\"src/**/*.ts\"]}' > tsconfig.json" \
  "mkdir -p src && echo 'export function hello() { return \"hello\"; }' > src/index.ts && echo 'import { hello } from \"./index.js\"; console.log(hello());' > src/cli.ts"

run_scenario "R2-S10" "Mixed language" "/tmp/gauntlet-mixed" \
  "Build a TypeScript CLI that shells out to a Python script for data processing. Both need tests." \
  "pnpm init && pnpm add -D typescript vitest && echo '{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"Node16\",\"moduleResolution\":\"Node16\",\"strict\":true},\"include\":[\"src/**/*.ts\"]}' > tsconfig.json && echo '[project]
name = \"processor\"
version = \"0.1.0\"
requires-python = \">=3.10\"
[tool.pytest.ini_options]
testpaths = [\"tests\"]' > pyproject.toml" \
  "mkdir -p src scripts tests && touch tests/__init__.py"

# ═══ R3: ADVERSARIAL ═══

run_scenario "R3-S11" "Vague goal" "/tmp/gauntlet-vague" \
  "Make it better." \
  "pnpm init && pnpm add -D typescript vitest" \
  "mkdir -p src && echo 'export function add(a: number, b: number) { return a + b; }' > src/index.ts"

run_scenario "R3-S12" "Conflicting instructions" "/tmp/gauntlet-conflict" \
  "Build a TypeScript package with Vitest tests. Do NOT modify package.json." \
  "pnpm init && pnpm add -D typescript vitest && echo '{\"compilerOptions\":{\"target\":\"ES2022\",\"module\":\"Node16\",\"moduleResolution\":\"Node16\",\"strict\":true},\"include\":[\"src/**/*.ts\"]}' > tsconfig.json" \
  "mkdir -p src && echo 'export function multiply(a: number, b: number) { return a * b; }' > src/index.ts"

# ═══ RESULTS ═══
echo "═══════════════════════════════════════"
echo "GAUNTLET RESULTS"
echo "═══════════════════════════════════════"
echo ""
column -t -s'|' "$RESULTS_FILE" 2>/dev/null || cat "$RESULTS_FILE"
echo ""
echo "PASS: $pass | PARTIAL: $partial | FAIL: $fail | INCOMPLETE: $incomplete | UNSAFE_FAIL: $unsafe"
echo "Total: $((pass + partial + fail + incomplete + unsafe)) scenarios"
echo ""
echo "Target: PASS 8+ | PARTIAL ≤3 | FAIL 0 | INCOMPLETE 0 | UNSAFE_FAIL 0"
echo "Before: PASS 5 | PARTIAL 5 | FAIL 1 | INCOMPLETE 1"
