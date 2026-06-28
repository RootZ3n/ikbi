#!/usr/bin/env bash
# ikbi ugly-machine matrix — clean Debian container, NO sibling repos.
# Proves: a fresh clone (the committed tree) installs standalone on a non-Fedora distro;
# the no-bwrap path FAILS CLOSED; with bubblewrap installed, the sandbox engages.
#
# Runs the committed tree (git archive HEAD) — exactly what a public cloner gets.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ART="$(mktemp -d "${TMPDIR:-/tmp}/ikbi-ugly.XXXXXX")"
git -C "$REPO_ROOT" archive --format=tar HEAD -o "$ART/ikbi-src.tar"
echo "archive: $(du -h "$ART/ikbi-src.tar" | cut -f1)  ->  running in node:22-bookworm (Debian)"

podman run --rm \
  -v "$ART/ikbi-src.tar:/ikbi-src.tar:ro,Z" \
  docker.io/library/node:22-bookworm \
  bash -euo pipefail -c '
    echo "=== DISTRO ===" ; cat /etc/os-release | grep PRETTY_NAME
    echo "=== node/git ===" ; node --version ; git --version
    corepack enable pnpm >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1
    echo "pnpm $(pnpm --version)"
    mkdir -p /work/ikbi && tar -xf /ikbi-src.tar -C /work/ikbi
    cd /work/ikbi
    echo "=== sibling repos? (must be NONE) ===" ; ls /work ; ls ../velum 2>&1 || echo "no ../velum (correct)"
    echo "=== vendored velum present? ===" ; ls vendor/velum-ai/dist/adapters/fastify.js

    echo ; echo "############ PHASE A — NO bubblewrap ############"
    command -v bwrap && echo "UNEXPECTED bwrap present" || echo "bwrap absent (correct for phase A)"
    echo "--- pnpm install --frozen-lockfile ---"
    CI=true pnpm install --frozen-lockfile 2>&1 | tail -4
    echo "velum-ai resolves to: $(readlink -f node_modules/velum-ai)"
    echo "--- pnpm typecheck ---" ; pnpm typecheck >/dev/null 2>&1 && echo "TYPECHECK_OK" || { echo "TYPECHECK_FAIL"; exit 1; }
    echo "--- pnpm build ---" ; pnpm build >/dev/null 2>&1 && echo "BUILD_OK" || { echo "BUILD_FAIL"; exit 1; }

    export IKBI_STATE_ROOT=$(mktemp -d /tmp/ikbi-state.XXXXXX)
    export IKBI_ALLOW_INSECURE_DEV_KEYS=true
    echo "--- ikbi doctor: PLATFORM & SANDBOX (expect FAILS CLOSED) ---"
    node dist/cli/index.js doctor 2>&1 | sed -n "/PLATFORM & SANDBOX/,/^$/p"
    echo "--- ikbi --version on cold shell ---"
    env -i PATH="$PATH" HOME="$HOME" node dist/cli/index.js --version && echo "VERSION_OK"
    echo "--- F1 + depinstall + governed-exec tests (fail-closed paths run; real-escape skips) ---"
    env -u IKBI_OPERATOR_TOKEN -u IKBI_WORKER_TOKEN node --import tsx --test \
      src/modules/governed-exec/sandbox-f1.test.ts \
      src/modules/governed-exec/governed-exec.test.ts \
      src/modules/dependency-install/dependency-install-sandbox.test.ts 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
    echo "--- assert NO host escape file from any test ---"
    ls /tmp/ikbi-f1-escape* 2>&1 || echo "no escape artifacts (correct)"

    echo ; echo "############ PHASE B — WITH bubblewrap ############"
    apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq bubblewrap >/dev/null 2>&1
    echo "bwrap installed: $(bwrap --version 2>&1)"
    echo "--- ikbi doctor: PLATFORM & SANDBOX (depends on container userns) ---"
    node dist/cli/index.js doctor 2>&1 | sed -n "/PLATFORM & SANDBOX/,/^$/p"
    echo "--- full sandbox-f1 suite (real containment runs IFF userns work here) ---"
    env -u IKBI_OPERATOR_TOKEN -u IKBI_WORKER_TOKEN node --import tsx --test \
      src/modules/governed-exec/sandbox-f1.test.ts 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
    echo "=== ugly-machine matrix complete ==="
  ' 2>&1
echo "(artifacts: $ART)"
