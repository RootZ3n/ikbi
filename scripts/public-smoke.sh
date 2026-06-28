#!/usr/bin/env bash
# ikbi public smoke — a fast, API-key-free sanity check for a NEW technical user.
#
# This is NOT the 500-run proof or the hostile gauntlet. It is the "did I clone + install this
# correctly, and is the safety model intact on MY machine?" check a stranger runs first. It needs
# NO model/provider API keys: every step is a local compile / test / report.
#
# What it verifies:
#   1. Toolchain present (node >= 22, pnpm) and dependencies installed
#   2. `pnpm typecheck` (the repo compiles in strict mode)
#   3. The OS sandbox security regressions:
#        - F1 governed-exec workspace-escape containment (+ fail-closed when no bwrap)
#        - dependency-install sandbox / escape containment
#        - governed-exec allowlist + gate-wall
#   4. First-run UX: `ikbi doctor` runs on a cold shell, exit 0, no raw stack trace,
#      and prints the PLATFORM & SANDBOX report
#   5. Sandbox posture: is bubblewrap working here, or will risky code fail closed?
#   6. A tiny TypeScript build fixture compiles with the repo toolchain (no model)
#   7. Receipts subsystem integrity (the audit trail every promotion is backed by)
#
# Exit 0 iff every required step passed. A missing bubblewrap is NOT a failure — the smoke
# verifies the fail-closed behavior instead and tells you what to install for full capability.
#
# Usage:  bash scripts/public-smoke.sh        (run from anywhere; resolves its own repo root)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Isolated state + safe dev keys so the smoke never touches a real operator's state and the
# info commands load on a fresh shell. These are the SAME guarantees `pnpm test` uses.
SMOKE_STATE="$(mktemp -d "${TMPDIR:-/tmp}/ikbi-smoke-state.XXXXXX")"
export IKBI_STATE_ROOT="$SMOKE_STATE"
export IKBI_ALLOW_INSECURE_DEV_KEYS=true
TMP_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ikbi-smoke-work.XXXXXX")"
trap 'rm -rf "$TMP_WORK"' EXIT

pass=0; fail=0; warn=0
declare -a FAILED=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
yellow(){ printf '\033[33m%s\033[0m' "$1"; }

ok()   { echo "  $(green PASS) — $1"; pass=$((pass+1)); }
bad()  { echo "  $(red FAIL) — $1"; fail=$((fail+1)); FAILED+=("$1"); }
note() { echo "  $(yellow WARN) — $1"; warn=$((warn+1)); }
step() { echo; echo "── $1"; }

echo "═══════════════════════════════════════════════════════════════"
echo " ikbi public smoke — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo " repo: $REPO_ROOT"
echo " state (isolated): $IKBI_STATE_ROOT"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Toolchain + dependencies ──────────────────────────────────────────────
step "1. Toolchain + dependencies"
NODE_V="$(node --version 2>/dev/null || echo none)"
NODE_MAJOR="$(echo "$NODE_V" | sed -E 's/^v?([0-9]+).*/\1/')"
if [ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null; then ok "node $NODE_V (>= 22)"; else bad "node $NODE_V — ikbi needs Node 22+"; fi
if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm --version)"; else bad "pnpm not found — install with: npm i -g pnpm"; fi
if [ ! -d node_modules ] || [ ! -e node_modules/velum-ai ]; then
  echo "  … node_modules missing — running pnpm install --frozen-lockfile"
  if CI=true pnpm install --frozen-lockfile >/dev/null 2>&1; then ok "pnpm install"; else bad "pnpm install failed — see: pnpm install --frozen-lockfile"; fi
else
  ok "node_modules present (velum-ai vendored: $(readlink -f node_modules/velum-ai | sed "s#$REPO_ROOT/##"))"
fi

# ── 2. Typecheck ─────────────────────────────────────────────────────────────
step "2. Typecheck (strict compile)"
if pnpm typecheck >/dev/null 2>&1; then ok "pnpm typecheck"; else bad "pnpm typecheck failed — run \`pnpm typecheck\` to see errors"; fi

# Build is needed for the cold-CLI doctor step (it runs dist/cli/index.js).
if pnpm build >/dev/null 2>&1; then ok "pnpm build (dist/)"; else bad "pnpm build failed — run \`pnpm build\` to see errors"; fi

# ── 3. Sandbox security regressions ──────────────────────────────────────────
step "3. Sandbox security regressions (the safety model)"
run_tests() {
  local label="$1"; shift
  if env -u IKBI_OPERATOR_TOKEN -u IKBI_WORKER_TOKEN node --import tsx --test "$@" >"$TMP_WORK/$label.log" 2>&1; then
    local n; n="$(grep -E '^# pass' "$TMP_WORK/$label.log" | grep -oE '[0-9]+' | head -1)"
    local s; s="$(grep -E '^# skipped' "$TMP_WORK/$label.log" | grep -oE '[0-9]+' | head -1)"
    ok "$label ($n passed${s:+, $s skipped})"
  else
    bad "$label — see $TMP_WORK/$label.log"
  fi
}
run_tests "F1-workspace-escape"       src/modules/governed-exec/sandbox-f1.test.ts src/modules/governed-exec/sandbox.test.ts
run_tests "governed-exec"             src/modules/governed-exec/governed-exec.test.ts src/modules/governed-exec/config.test.ts
run_tests "dependency-install-escape" src/modules/dependency-install/dependency-install-sandbox.test.ts src/modules/dependency-install/dependency-install.test.ts
run_tests "fresh-shell-info-cmds"     src/cli/bootstrap.test.ts src/cli/help-flags.test.ts
run_tests "doctor-platform-sandbox"   src/cli/doctor-sandbox.test.ts

# ── 4. First-run UX: cold doctor ─────────────────────────────────────────────
step "4. First-run: \`ikbi doctor\` on a cold shell"
DOCTOR_OUT="$(env -i PATH="$PATH" HOME="$HOME" IKBI_STATE_ROOT="$IKBI_STATE_ROOT" node dist/cli/index.js doctor 2>&1)"
DOCTOR_RC=$?
if [ "$DOCTOR_RC" -eq 0 ]; then ok "ikbi doctor exited 0"; else bad "ikbi doctor exited $DOCTOR_RC"; fi
if echo "$DOCTOR_OUT" | grep -q "PLATFORM & SANDBOX"; then ok "doctor prints the PLATFORM & SANDBOX report"; else bad "doctor missing the PLATFORM & SANDBOX report"; fi
if echo "$DOCTOR_OUT" | grep -qE '^\s+at\s+\S'; then bad "doctor leaked a raw stack frame"; else ok "no raw stack trace from doctor"; fi
# version on a cold shell (the stranger's literal first command)
if env -i PATH="$PATH" HOME="$HOME" node dist/cli/index.js --version >/dev/null 2>&1; then ok "ikbi --version on a cold shell (exit 0)"; else bad "ikbi --version crashed on a cold shell"; fi

# ── 5. Sandbox posture ───────────────────────────────────────────────────────
step "5. Sandbox posture on THIS host"
if echo "$DOCTOR_OUT" | grep -q "Risky project code will — runs SANDBOXED"; then
  ok "bubblewrap working — risky project code runs SANDBOXED"
elif echo "$DOCTOR_OUT" | grep -q "FAILS CLOSED"; then
  note "bubblewrap NOT available — risky project code FAILS CLOSED (safe). Install bubblewrap for full build capability."
elif echo "$DOCTOR_OUT" | grep -q "UNSANDBOXED"; then
  note "risky code would run UNSANDBOXED (an override/dev mode is set) — see doctor output"
else
  bad "could not determine sandbox posture from doctor output"
fi

# ── 6. Tiny TypeScript build fixture (no model) ──────────────────────────────
step "6. Tiny TypeScript build fixture compiles"
FIX="$TMP_WORK/ts-fixture"; mkdir -p "$FIX/src"
cat > "$FIX/tsconfig.json" <<'JSON'
{ "compilerOptions": { "strict": true, "noEmit": false, "outDir": "dist", "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext" }, "include": ["src/**/*.ts"] }
JSON
cat > "$FIX/src/add.ts" <<'TS'
export function add(a: number, b: number): number { return a + b; }
if (add(2, 3) !== 5) throw new Error("math is broken");
TS
if node_modules/.bin/tsc -p "$FIX/tsconfig.json" >/dev/null 2>&1 && [ -f "$FIX/dist/add.js" ] && node "$FIX/dist/add.js"; then
  ok "tsc compiled + ran a tiny TS fixture"
else
  bad "tiny TS fixture failed to compile/run"
fi

# ── 7. Receipts subsystem integrity ──────────────────────────────────────────
step "7. Receipts subsystem (the audit trail)"
run_tests "receipts-subsystem" src/core/receipt/store.test.ts src/core/receipt/grouping.test.ts src/core/workspace/promote-receipt-durability.test.ts

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════"
echo " public smoke: $(green "$pass passed"), $( [ "$fail" -gt 0 ] && red "$fail failed" || echo "0 failed" ), $warn warning(s)"
if [ "$fail" -gt 0 ]; then
  echo " FAILURES:"; for f in "${FAILED[@]}"; do echo "   - $f"; done
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi
echo " RESULT: ikbi public smoke PASSED — safe to proceed to a first build."
echo " (Configure a provider/API key, then: ikbi doctor && ikbi build \"...\" --repo <path>)"
echo "═══════════════════════════════════════════════════════════════"
exit 0
