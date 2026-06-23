/**
 * ikbi hooks — config defaults.
 *
 * Read through `moduleEnv("hooks")` — the reader auto-prefixes with IKBI_HOOKS_.
 * For now, the hook system is always enabled. A future `IKBI_HOOKS_ENABLED=false`
 * env var can disable it globally.
 */

/** Whether the hook system is active (default: true). */
export const hooksEnabled = (): boolean => process.env.IKBI_HOOKS_ENABLED !== "false";
