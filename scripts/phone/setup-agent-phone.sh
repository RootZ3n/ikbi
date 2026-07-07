#!/usr/bin/env bash
# ikbi agent-phone bootstrap — RUN THIS INSIDE TERMUX ON THE PIXEL 9.
#
# Stands up everything Pehlichi's governed body (the phone_* tools) needs on-device:
#   1. Termux:API bridge (camera / mic / sensors / GPS / battery / TTS / notifications / torch)
#   2. Node.js 22+ + git (so ikbi itself can run on the phone — the Phase-A "stands alone" target)
#   3. An SSH server (so a PC-hosted ikbi can drive the phone during development, IKBI_PHONE_SSH_HOST)
#   4. Keep-alive (wake-lock + battery-optimization guidance) so Android does not kill the agent
#
# This does NOT install the local model — see scripts/phone/README.md for the Gemma 4 step. This
# script is idempotent: re-run it any time. It changes only Termux's own environment, nothing
# outside the app sandbox.
#
# PREREQUISITE you must do BY HAND first (Termux cannot do it for you):
#   Install BOTH apps from F-Droid (NOT the Play Store builds — they are frozen/incompatible):
#     • Termux            https://f-droid.org/packages/com.termux/
#     • Termux:API        https://f-droid.org/packages/com.termux.api/
#   The Termux:API *app* is the actual bridge to the hardware; the `termux-api` package below is
#   only the CLI that talks to it. Without the app, every phone_* tool will fail closed.

set -u

say()  { printf '\033[1;36m[agent-phone]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[agent-phone] WARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[agent-phone] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. sanity: are we actually in Termux? ─────────────────────────────────────
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] && echo "$PREFIX" | grep -q "com.termux" \
  || die "this must be run INSIDE Termux on the phone (PREFIX does not look like Termux)."
say "Termux detected: $PREFIX"

# ── 1. packages ───────────────────────────────────────────────────────────────
say "Updating package lists + installing the toolchain (this can take a few minutes)…"
pkg update -y  || warn "pkg update had warnings — continuing."
# termux-api = the CLI that fronts the Termux:API app; the rest = ikbi's on-device runtime + remote access.
pkg install -y termux-api nodejs-lts git openssh termux-services \
  || pkg install -y termux-api nodejs git openssh termux-services \
  || die "package install failed — check network + 'pkg update' and retry."

command -v node >/dev/null || die "node did not install."
say "Node $(node --version) / npm $(npm --version 2>/dev/null || echo '?') ready."

# ── 2. storage + a home for captures ──────────────────────────────────────────
# termux-setup-storage pops a system permission dialog the first time — approve it so photos/audio
# can be written where you can retrieve them. Safe to run repeatedly.
say "Requesting storage access (approve the Android dialog if it appears)…"
termux-setup-storage || warn "storage setup skipped/declined — on-device captures still work inside the ikbi worktree."
mkdir -p "$HOME/ikbi-agent/phone-captures"
say "Capture directory: $HOME/ikbi-agent/phone-captures"

# ── 3. SSH server (remote transport for PC→phone development) ──────────────────
# ikbi on your PC reaches the phone via `ssh <host> termux-…` (IKBI_PHONE_SSH_HOST). Termux sshd
# listens on port 8022 as your Termux user. Key-based auth is strongly preferred over a password.
say "Configuring the SSH server (port 8022)…"
if [ ! -f "$HOME/.ssh/authorized_keys" ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  warn "no authorized_keys yet. From your PC run:  ssh-copy-id -p 8022 $(whoami)@<phone-ip>"
  warn "…or paste your PC's public key into ~/.ssh/authorized_keys on the phone."
fi
sshd || warn "sshd did not start now — run 'sshd' manually, or enable it via termux-services."

TERMUX_USER="$(whoami)"
PHONE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
say "SSH login (LAN):  ssh -p 8022 ${TERMUX_USER}@${PHONE_IP:-<phone-ip>}"
say "For anywhere-access, join this phone to your Tailscale tailnet and use its 100.x address."

# ── 4. keep-alive: don't let Android kill the agent ───────────────────────────
termux-wake-lock && say "Wake-lock acquired (Termux stays alive with the screen off)." \
  || warn "could not acquire a wake-lock."
warn "IMPORTANT: in Android Settings → Apps → Termux → Battery, set it to UNRESTRICTED, or"
warn "Android will still eventually kill the agent in the background."

# ── 5. verify the Termux:API bridge is really wired ───────────────────────────
say "Verifying the Termux:API hardware bridge…"
if command -v termux-battery-status >/dev/null && termux-battery-status >/dev/null 2>&1; then
  PCT="$(termux-battery-status 2>/dev/null | grep -o '"percentage"[^,]*' || true)"
  say "Termux:API OK — battery reads: ${PCT:-(ok)}. Camera/mic/sensors are reachable."
else
  warn "termux-battery-status failed. Install the Termux:API *app* from F-Droid (see the header),"
  warn "then re-run this script. The phone_* tools need that app to reach the hardware."
fi

say "Done. Next: install Gemma 4 (scripts/phone/README.md), then deploy ikbi's dist/ here."
