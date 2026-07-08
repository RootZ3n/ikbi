# HANDOFF — Self-Sustaining Lab initiative (resume here)

> Durable handoff for the multi-day effort to make the lab run on **ikbi as the user's own Claude
> Code**, before their **Claude Max plan expires ~2026-07-12** (drops to Pro). The in-session task
> board does NOT persist across sessions — **this file + the `ikbi-self-sustaining-lab` memory are the
> source of truth.** To resume: read this, then start at "NEXT WORK ITEM".

## North star
"**ikbi handles the lab; Claude Code only for edge cases + final review**" — proven by *building real
projects with ikbi* (dogfooding is the bug-finder). Emphasis on **UI work** (hard: no unit tests).

## Done so far (all committed in this repo unless noted)
- **Track 1 (knowledge):** `docs/UI-OPERATIONS.md` — the UI edit→verify→deploy→reload playbook + gotchas;
  linked from `CLAUDE.md`.
- **Track 2 core (UI verification):** `scripts/ui-verify/ui-shot.mjs` — headless screenshot verifier
  (system Brave via playwright-core; `--mobile`, `--fresh`). Solves "UI has no tests." Run:
  `node scripts/ui-verify/ui-shot.mjs http://127.0.0.1:18796 /tmp/g.png --mobile` then view the PNG.
- **Track 3 (arm the trio):** `pehlichi/skills/peh-ui/SKILL.md` — the trio (Peh/Ptah/Luna) can now run a
  UI change with their own tools (`patch`/`terminal`/`browser_snapshot`/`vision_analyze`). Verified the
  skill loader discovers it.
- **Onboarding toggle:** deployment default via `IKBI_ONBOARDING` env (server injects `/peh-config.js`;
  default ON=public, `=off`=lab) + a ⚙ Grove settings toggle. Phone is live + off.

## NEXT WORK ITEM → "UI-change ikbi skill" (Track 2 finish)
Wrap the full UI loop into an **ikbi skill** so ikbi ITSELF runs a UI change end-to-end (not just the
agents). The loop, from `docs/UI-OPERATIONS.md`:
`edit ui/<file>` → `curl -s :18796/<file> | grep` (served?) → `ui-shot … --mobile` + view (rendered?) →
`rsync -az ui/<file> pixel:ikbi-agent/ui/<file>` (deploy phone) → `git commit`.
ikbi auto-discovers skills; mirror an existing ikbi skill's format. This lets a plain "make the Grove
text bigger" run through ikbi with real verification.

## Then, in order
1. **Dogfood build #1** — build a real small project with ikbi (cheap roster), fix every harness bug found.
2. **Verification pass** — confirm build / fix / repl / UI / deploy each work end-to-end on cheap/local
   models; document pass/fail per capability.
3. **Self-heal loop** — tune monitor + proving-ground for regression auto-detect+repair (see the
   `ikbi-selfheal-handoff` + `ikbi-proving-ground-harness` memories).
4. **Track 1 finish** — audit per-repo `CLAUDE.md`, fill gaps. **Dogfood build #2.**

## Waiting on the user (physical, when home)
- Boot the **128 GB field-kit USB on Mushin → run Memtest86+ overnight** → if errors, test one RAM stick
  at a time to find the bad module. (CPU was cleared; RAM is the prime suspect — non-ECC, silent.)
- Optional: `IKBI_ONBOARDING=off` + restart on the PC/laptop lab servers (or flip the ⚙ toggle once).
