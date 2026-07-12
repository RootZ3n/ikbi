# UI Operations Playbook — how to change, verify, and ship the Pehverse UI

> Written for ikbi + the agent trio (and future operators) so UI work is a **repeatable recipe**,
> not tribal knowledge. UIs have **no unit tests**, so the discipline here IS the safety net:
> *edit → verify it actually landed → deploy → confirm.* Follow it every time.

## 1. The surfaces (where the pixels live)

| Surface | Path | Served how |
|---|---|---|
| **Web SPA "Grove/Peh"** (the phone + desktop UI) | `ui/` | Fastify `@fastify/static`, root = `dist/server/../../ui` → **the source `ui/` directly** (NO `dist/ui` copy). Editing `ui/*` is live on the next request — **no rebuild needed.** |
| **TUI** (Ink/React client) | `tui/` | Standalone package, talks to `/chat`. Needs `pnpm build` in `tui/`. |
| **Server** (serves the SPA + APIs) | `src/server/index.ts` | Fastify on **:18796**. `uiDir` = `join(__dirname,"..","..","ui")`. |

**Web SPA files** (plain JS/CSS/HTML, no framework, no build step):
- `ui/index.html` — shell + `<link rel="stylesheet" href="ikbi.css">` (unversioned)
- `ui/ikbi.css` — **all styling** (~1500 lines; design tokens as CSS vars: `--ikbi-cream #f5ead6`, `--ikbi-gold #d4a843`, `--ikbi-fire`, `--ikbi-turquoise`, `--ikbi-stone` (dim), etc.)
- `ui/scenes.js` — the Grove terminal, scene rendering, voice in/out (`groveSpeak`, `pickPehVoice`), attach/share
- `ui/app.js` — backend status, command bar (`.peh-cmd`), boot (`start()`)
- `ui/api.js` — client fetch layer
- `ui/peh-guide.js` — the Build Log drawer (`.peh-jrnl-*`)
- `ui/sw.js` — service worker; **only** intercepts the `share-target` POST, does **NOT** cache app assets
- `ui/manifest.json` — PWA manifest (Share→Peh target)

## 2. The golden flow (do this EVERY UI change)

```bash
cd /pehverse/repos/ecosystem/ikbi
# 1. EDIT the source file
#    (ui/ikbi.css for styling, ui/scenes.js for Grove behavior, etc.)

# 2. VERIFY it actually landed in what the server SERVES (this is the "test"):
curl -s http://127.0.0.1:18796/ikbi.css | grep -c '<a unique string from your change>'
#    >=1 means the running server is serving your change. 0 means wrong file/path.

# 3. DEPLOY to the phone (the phone runs its OWN ikbi server; editing the PC copy is NOT enough):
rsync -az ui/ikbi.css pixel:ikbi-agent/ui/ikbi.css
#    verify on the phone too:
ssh pixel 'curl -s http://127.0.0.1:18796/ikbi.css | grep -c "<unique string>"'

# 4. COMMIT
git add ui/ikbi.css && git commit -m "fix(ui): <what changed and why>"

# 5. RELOAD Grove on the phone. Server sends `cache-control: max-age=0`, so a normal reload
#    revalidates. If it's stubbornly stale, the fix is almost never the browser — see §4.
```

**Which server is the user on?** The phone screenshot shows `localhost:18796` → they're on the **phone's** server, so step 3 (rsync to `pixel`) is mandatory. Other possible targets: PC `pehverse:18796`, laptop `pehtop` (one-way mirror — NOT auto-updated; rsync there too if they use it).

## 3. Hard-won gotchas (these cost real time — heed them)

- **`.peh-grove-only-mode` is a TRAP for mobile fixes.** That class only activates on the *share-an-image* flow. Opening Grove normally = the **regular** UI (taskbar visible). So **scope mobile UI fixes to `@media (max-width:640px)`**, NOT `.peh-grove-only-mode`, or they silently never apply.
- **Floating overlays that bury the chat on mobile** (hide/reposition under `@media(max-width:640px)`): `.peh-cmd` (command bar), `.peh-status` (online pill), `.peh-jrnl-btn` (Build Log), `.ikbi-chat-btn` (orange chat FAB), `.peh-onboard-help` (the teaching-Peh star button).
- **"CSS won't update after hard reload" is almost always NOT caching.** First check the rule is *correctly scoped* (see the `.peh-grove-only-mode` trap) and that the server actually serves it (`curl | grep`). The SW does not cache assets. Only after both check out, suspect cache → add `?v=<n>` to the `<link>`/`<script>` in `index.html`.
- **Readability = brightness + size.** The operator has low vision. Faint text used dim `--ikbi-stone` / low `opacity` / 11–13px. The fix pattern: full-contrast `--ikbi-cream`, `opacity:1`, no italic, and on mobile bump sizes (msg 17px, secondary 16px, input 16px). When told "bigger/brighter," push further — 19–20px, pure cream/white.
- **No dist copy of the UI** — never look for `dist/ui`. Edit `ui/` and it's served.

## 4. Verifying a UI change WITHOUT unit tests

1. **Serve-grep** (mandatory): `curl … | grep` proves the change is in the served bytes.
2. **Lint** (cheap correctness): run the JS/CSS through a linter/parser before shipping.
3. **Headless screenshot** (the real check — see below): render the page in headless Chromium (Playwright), screenshot it, and eyeball/diff. This is the UI analog of the osapa QEMU boot test — proof the change *renders*, not just parses.
4. **On-device**: the operator reloads and confirms. Ask a specific question ("is the star gone? is the text readable?").

## 5. Commit + deploy discipline

- One focused commit per change, message says **what + why** (the why is what future-cheap-models need).
- Always `rsync` to every server the operator actually uses (phone is primary; PC is the source; laptop is a manual mirror).
- Never leave the phone out of sync — a change that works on the PC but not the phone reads as "broken."

## 6. The screenshot verifier (scripts/ui-verify/ui-shot.mjs)

Renders a UI surface headlessly (system Brave via playwright-core — no bundled browser) and writes a
PNG, so a change can be **seen**, not guessed. It pre-sets `localStorage['pehverse-onboarded']=1` so it
lands on the real UI, not the onboarding modal.

```bash
# desktop viewport
node scripts/ui-verify/ui-shot.mjs http://127.0.0.1:18796 /tmp/ui.png
# phone viewport (390x844) — use this for Grove/mobile checks
node scripts/ui-verify/ui-shot.mjs http://127.0.0.1:18796 /tmp/grove.png --mobile
```
Then open/read the PNG. This is the UI analog of osapa's QEMU boot test: proof the change RENDERS
correctly, not merely that the CSS/JS parses. Verified live: it confirmed the star-button removal +
readability bump actually rendered on mobile.
