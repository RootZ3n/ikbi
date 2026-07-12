/**
 * ikbi hooks — config defaults.
 *
 * Read through `moduleEnv("hooks")` — the reader auto-prefixes with IKBI_HOOKS_.
 */

/** Whether the hook system is active at all (default: true). `IKBI_HOOKS_ENABLED=false` kills it. */
export const hooksEnabled = (): boolean => process.env.IKBI_HOOKS_ENABLED !== "false";

/**
 * Whether to load PROJECT hooks (`<repo>/.ikbi/hooks.json`) — default OFF (Codex C5).
 *
 * A project's hooks.json is attacker-controlled input: merely building an untrusted repo would
 * otherwise auto-run its `command` strings via `/bin/sh -c`. The operator's OWN global hooks
 * (`~/.ikbi/hooks.json`) are trusted and stay on; the repo's hooks require an explicit opt-in
 * (`IKBI_PROJECT_HOOKS_ENABLED=true`), i.e. "I trust this repo's hooks".
 */
export const projectHooksEnabled = (): boolean => process.env.IKBI_PROJECT_HOOKS_ENABLED === "true";
