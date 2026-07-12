# Agent Phone — Pehlichi's governed body (Phase A)

Turn a **Pixel 9** into an autonomous AI-agent phone: ikbi runs the agent loop, a **local Gemma 4**
model is the brain, and the **`phone_*` tools** give Pehlichi a governed body — camera, microphone,
sensors, GPS, battery/thermal, text-to-speech, notifications, and torch.

**Phase A goal — "the phone stands alone":** with the PC off *and* Wi-Fi off, you talk to Pehlichi,
it reasons on the on-device Gemma 4, takes a photo / records audio / reads a sensor, and tells you
what it perceived. That is the redundancy guarantee. Phase C (a cascade that upgrades to a cloud/PC
brain when reachable) layers on top later.

Everything the agent does on the phone routes through ikbi's governance: **governed-exec allowlist →
gate-wall → receipts**, gated by permission mode, and cut instantly by the kill-switch. The camera is
*granted, logged, and revocable* — never a silent default.

---

## The two ways to run (you'll use both, in this order)

| Mode | Where ikbi runs | Brain | How `phone_*` reaches the hardware | Use it for |
|------|-----------------|-------|-------------------------------------|-----------|
| **Remote (dev)** | your PC | your normal model | `ssh <phone> termux-…` (set `IKBI_PHONE_SSH_HOST`) | proving the tools work against the real phone while you iterate on the PC |
| **On-device (target)** | the phone, in Termux | **local Gemma 4** | `termux-…` run locally (default transport) | the actual standalone agent phone |

The same `phone_*` code serves both — only the *transport* differs (`phone-tools.ts`).

---

## Step 1 — Bootstrap the phone

Install **both** apps from **F-Droid** (not the Play Store builds): [Termux](https://f-droid.org/packages/com.termux/)
and [Termux:API](https://f-droid.org/packages/com.termux.api/). The Termux:API *app* is the actual
hardware bridge — without it every `phone_*` tool fails closed.

Then, inside Termux on the phone:

```bash
# copy this repo's script over (or paste it), then:
bash setup-agent-phone.sh
```

It installs the Termux:API CLI, Node 22+, git, an SSH server (port 8022), acquires a wake-lock, and
verifies the hardware bridge with a live `termux-battery-status`. Follow its notes: approve the
storage dialog, set Termux's battery mode to **Unrestricted**, and add your PC's SSH key.

> **Anywhere access:** join the phone to your **Tailscale** tailnet and use its `100.x.y.z` address
> (or MagicDNS name) everywhere below instead of the LAN IP — that's how you reach it off your home network.

---

## Step 2 — Prove the tools remotely (PC-hosted ikbi)

From your PC, point ikbi at the phone and run the REPL:

```bash
export IKBI_PHONE_SSH_HOST="u0_aXXX@100.x.y.z"   # your Termux user @ the phone's Tailscale/LAN IP
# remote transport shells out via ssh, so allow the ssh binary for this session:
export IKBI_GOVERNED_EXEC_ALLOWLIST="ssh"
node dist/cli/index.js repl
```

Then just ask:

- *"Take a photo with the back camera and tell me what you see."* → `phone_take_photo` → `vision_analyze`
- *"What sensors does the phone have?"* → `phone_read_sensor` (list)
- *"Read the accelerometer."* / *"What's the battery and temperature?"* / *"Say 'hello' out loud."*

Run the REPL in `confirm` permission mode if you want to approve each camera/mic use;
`readonly` blocks the body entirely. `auto` (default) lets the autonomous phone act, backed by
receipts + kill-switch.

> Remote note: over SSH the phone's login shell word-splits the command, so keep remote save paths
> space-free. Locally (Step 3) paths are fully quote-safe via `execFile`.

---

## Step 3 — Install the local brain (Gemma 4) on the phone

Pixel 9 (12 GB RAM) runs **Gemma 4 E4B** (~2.5 GB, ~4B effective, multimodal) comfortably. Serve it
behind a localhost OpenAI-compatible endpoint so ikbi can call it. Easiest path in Termux:

```bash
pkg install -y ollama            # if unavailable in your Termux repo, build llama.cpp (see below)
ollama serve &                   # exposes http://localhost:11434
ollama pull gemma4:e4b           # ~2.5 GB — do this once, on Wi-Fi
```

Fallback if Ollama isn't packaged for your Termux: build `llama.cpp` (`pkg install cmake clang`,
`cmake -B build && cmake --build build`), download the **Gemma 4 E4B Q4_K_M GGUF** + its vision
projector, and run `llama-server --host 127.0.0.1 --port 8080 -m gemma4-e4b-q4_k_m.gguf --mmproj …`.
Either way you get a local HTTP endpoint. (The NPU-accelerated Google AI Edge path is faster/cooler
but isn't a plain HTTP server yet — a later optimization.)

Multimodal payoff: because E4B has vision **and** an audio encoder, in fully-local mode the local
brain can see `phone_take_photo` output and hear `phone_record_audio` — no cloud vision/transcription.

---

## Step 4 — Run ikbi on the phone (standalone)

```bash
# on the PC: build, then sync dist/ + package.json + node_modules (runtime deps are pure-JS) to the phone
pnpm build
rsync -avz -e 'ssh -p 8022' dist package.json node_modules  "$IKBI_PHONE_SSH_HOST:~/ikbi-agent/"

# on the phone, point ikbi's local cascade rung at the Gemma 4 endpoint and start the REPL:
export IKBI_PROVIDER_BASE_URL="http://localhost:11434/v1"   # your local Gemma 4 server
node ~/ikbi-agent/dist/cli/index.js repl
```

Now unplug the network and pull the PC's power. Ask Pehlichi to take a photo and describe it. If it
answers, **Phase A is done** — the phone stands alone.

---

## Honest constraints (the on-device punch-list)

1. **No bubblewrap sandbox in Termux** (no user namespaces without root). On-device, governed-exec
   degrades to allowlist + policy + gate-wall + receipts — still fail-closed, but the OS-level jail is
   gone. This is the main argument for eventually rooting (Tier 2).
2. **Keep-alive** — the script's wake-lock + Unrestricted battery mode are required, or Android kills
   the agent in the background.
3. **Battery/thermal** — a local model is a heater; keep the agent phone plugged in. Pehlichi can
   watch its own device via `phone_battery` (and the Osapa thermal domain).
4. **Model tier** — E4B is a small brain; ikbi's evidence-based verification + governance is exactly
   what makes a cheap/local model reliable. Phase C adds a stronger rung when the network is up.
