# RELEASE.md — Public-Release Gate (deferred; lab version is the current priority)

ikbi is currently a private lab tool (`package.json "private": true`). This document tracks what must be done BEFORE any public release. None of these block lab use. Status as of HEAD 8ded301.

## Resolved (already shipped)

- **Insecure default trust keys:** `loadConfig` now fails closed unless `IKBI_ALLOW_INSECURE_DEV_KEYS=true` (mirrors the `IKBI_ALLOW_PUBLIC_BIND` gate). Doctor reports three states (set / insecure-dev-explicitly-allowed / blocker). DONE — listed here for completeness.

## Blocking — secrets & hygiene (must do before public release)

- **SECRET ROTATION & QUARANTINE (Critical):** `.env` (bootstrap operator/worker tokens, trust key material) and `state/providers.json` (real provider API keys) live in the working dir. They are gitignored and NOT in git history (verified), but can leak via archives, demos, screenshots, support bundles, or a mistaken commit. Before public release: rotate the provider keys, and ensure `.env`/`state/` are quarantined out of any release artifact. (Source: Codex audit #1.)

- **PROVIDER-KEY-IN-JSON DESIGN (Medium):** the provider roster (`registry.ts` ~224/230) accepts inline `apiKey` + arbitrary headers in JSON — which is why `state/providers.json` holds a raw key. For public release, prefer env-var references or secret-provider indirection over raw secrets in JSON config. NOTE (trio-relevant): this decision should be made BEFORE the trio adopts the same pattern across four agents — see "Trio-relevant" below. (Source: Codex audit #4.)

## Blocking — packaging & licensing (must do before public release)

- **LICENSE (High):** no LICENSE file exists. Public release without one leaves reuse legally ambiguous. Add a LICENSE and a matching `"license"` field in `package.json`. (Operator decision: which license — MIT / Apache-2.0 / source-available / proprietary.) (Source: Codex audit #3.)

- **NPM PACKAGING (High):** `package.json` has `"private": true` (correct for now — prevents accidental publish). For release: add a `"files"` whitelist or `.npmignore` so `npm pack` doesn't ship `src/`, compiled tests, source maps, docs, deploy files (currently ~1,102 files / 4.7 MB unpacked). Decide what's intentionally shipped. (Source: Codex audit #2.)

- **DEPLOY METADATA PLACEHOLDER (Low):** `deploy/ikbi.service:15` points to `https://github.com/your-org/ikbi` — a placeholder. Clean before release. (Source: Codex audit #6.)

## Positioning decision (not a fix — a choice)

- **DNS-REBINDING TOCTOU (Medium):** the egress-guard resolve→connect race is documented in `SECURITY.md` as an accepted residual (current mitigation: resolve-all-IPs-and-validate; planned: IP pinning, pending transport surface). For PRIVATE/LAB use this is acceptable. For a SECURITY-FORWARD PUBLIC release, either implement IP pinning OR clearly mark the project pre-production. This is a release-POSITIONING decision, not a lab blocker. (Source: Codex audit #5, both Hermes audits confirmed the TOCTOU.)

## Trio-relevant (a now-design note, not a release item)

- **SECRET HYGIENE UNDER THE TRIO:** as Peh/Ptah/Luna are built, their tooling must NEVER read `.env` or `state/providers.json` into a log, a context dump, or the shared knowledge store. Three+ agents operating in a workspace that contains live secrets multiply the leak surface. The shared store and agent logs should exclude the secret-bearing paths by construction. (Derived from Codex audit #1/#4 — relevant to the trio build, captured here so it isn't lost.)

## What is NOT a release blocker (consciously deferred, for the record)

- **Receipt queries O(n)** (reads all, filters in memory): fine now (bounded by retention); revisit if/when the trio puts sustained load on the core. Roadmap, not release.
- **Orchestrator size** (~810 lines): code-health refactor (extract competitive mode) — defer; do NOT refactor the recently-hardened orchestrator for line-count without a functional reason.
- **`Object.freeze` / strict-optional conditional spreading / single-trust-domain singletons:** INTENDED design choices (runtime security boundary; `exactOptionalPropertyTypes`; one-lab scope — documented in `SECURITY.md`). Not defects. Recorded so a future audit doesn't re-flag them.
- **Messy fix-commit history:** evidence of real iterative engineering for private dev; squash only for a public demo branch later.
