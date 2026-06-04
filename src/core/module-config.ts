/**
 * ikbi per-module config reader — the parallel-build SEAM (Step S).
 *
 * THE PROBLEM this solves: if every module added its knobs to `core/config.ts`,
 * that one file becomes a write-bottleneck — two builders touching it collide.
 *
 * THE CONVENTION: each module owns its own typed config slice. A module reads its
 * `IKBI_<MODULE>_*` block through `moduleEnv("<module>")` and parses the fields it
 * needs — in its OWN `src/modules/<module>/config.ts`. No module edits
 * `core/config.ts`. The engine config stays frozen to CORE knobs.
 *
 *     // src/modules/egress/config.ts
 *     import { moduleEnv } from "../../core/module-config.js";
 *     const env = moduleEnv("egress");                 // namespace = IKBI_EGRESS_
 *     export const egressConfig = Object.freeze({
 *       allowlist: env.list("ALLOWLIST"),               // IKBI_EGRESS_ALLOWLIST
 *       maxRedirects: env.int("MAX_REDIRECTS", 5, { min: 0 }), // IKBI_EGRESS_MAX_REDIRECTS
 *       enabled: env.bool("ENABLED", true),             // IKBI_EGRESS_ENABLED
 *     });
 *
 * The reader AUTO-PREFIXES every key with `IKBI_<MODULE>_`, so the born-`IKBI_*`
 * rule and per-module namespacing are enforced structurally — a module physically
 * cannot read another module's (or a core) variable through its own reader, which
 * keeps two modules' config namespaces from colliding.
 */

import { isAbsolute, resolve } from "node:path";

import { configEnv } from "./config.js";

/** A module name: lowercase, kebab-friendly. Becomes the `IKBI_<UPPER_SNAKE>_` prefix. */
const MODULE_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Inclusive integer bounds for `int(...)`. */
export interface IntBounds {
  readonly min?: number;
  readonly max?: number;
}

/** Trimmed value, or undefined when absent/blank. */
function trimmed(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * A typed reader bound to one module's `IKBI_<MODULE>_` namespace. Every accessor
 * takes the SUFFIX after the prefix (e.g. `int("MAX_REDIRECTS", ...)` reads
 * `IKBI_EGRESS_MAX_REDIRECTS`). All parse failures throw a clear, prefixed error
 * (fail-loud at startup, never a silently-wrong default).
 */
export class ModuleEnv {
  /** The module name (as given). */
  readonly module: string;
  /** The full env-var prefix this reader enforces, e.g. `IKBI_EGRESS_`. */
  readonly prefix: string;
  private readonly env: Readonly<NodeJS.ProcessEnv>;

  constructor(module: string, env: Readonly<NodeJS.ProcessEnv> = configEnv) {
    if (!MODULE_NAME_RE.test(module)) {
      throw new Error(
        `invalid module name "${module}" (expected lowercase kebab-case, e.g. "network-egress")`,
      );
    }
    this.module = module;
    this.prefix = `IKBI_${module.replace(/-/g, "_").toUpperCase()}_`;
    this.env = env;
  }

  /** The full env-var name for a suffix (e.g. `key("MAX_REDIRECTS")` → `IKBI_EGRESS_MAX_REDIRECTS`). */
  key(suffix: string): string {
    return this.prefix + suffix;
  }

  /** Raw trimmed value for a suffix, or undefined when absent/blank. */
  private raw(suffix: string): string | undefined {
    return trimmed(this.env[this.key(suffix)]);
  }

  /** Optional string. Returns `fallback` (default undefined) when absent/blank. */
  str(suffix: string): string | undefined;
  str(suffix: string, fallback: string): string;
  str(suffix: string, fallback?: string): string | undefined {
    return this.raw(suffix) ?? fallback;
  }

  /** REQUIRED string — throws a clear error when the var is unset/blank. */
  required(suffix: string): string {
    const v = this.raw(suffix);
    if (v === undefined) {
      throw new Error(`missing required env var ${this.key(suffix)} (module "${this.module}")`);
    }
    return v;
  }

  /** Boolean from 1/true/yes/on vs 0/false/no/off. Throws on an unrecognized value. */
  bool(suffix: string, fallback: boolean): boolean {
    const v = this.raw(suffix);
    if (v === undefined) return fallback;
    const lc = v.toLowerCase();
    if (["1", "true", "yes", "on"].includes(lc)) return true;
    if (["0", "false", "no", "off"].includes(lc)) return false;
    throw new Error(`invalid boolean for ${this.key(suffix)}: "${v}" (expected true/false)`);
  }

  /** Integer with optional inclusive bounds. Throws on a non-integer or out-of-range value. */
  int(suffix: string, fallback: number, bounds?: IntBounds): number {
    const v = this.raw(suffix);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n)) {
      throw new Error(`invalid integer for ${this.key(suffix)}: "${v}"`);
    }
    if (bounds?.min !== undefined && n < bounds.min) {
      throw new Error(`${this.key(suffix)}=${n} is below minimum ${bounds.min}`);
    }
    if (bounds?.max !== undefined && n > bounds.max) {
      throw new Error(`${this.key(suffix)}=${n} is above maximum ${bounds.max}`);
    }
    return n;
  }

  /** Float with optional inclusive bounds. Throws on a non-number or out-of-range value. */
  number(suffix: string, fallback: number, bounds?: IntBounds): number {
    const v = this.raw(suffix);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`invalid number for ${this.key(suffix)}: "${v}"`);
    }
    if (bounds?.min !== undefined && n < bounds.min) {
      throw new Error(`${this.key(suffix)}=${n} is below minimum ${bounds.min}`);
    }
    if (bounds?.max !== undefined && n > bounds.max) {
      throw new Error(`${this.key(suffix)}=${n} is above maximum ${bounds.max}`);
    }
    return n;
  }

  /**
   * Comma-separated list (trimmed, blanks dropped). Returns `fallback` (default
   * `[]`) when absent/blank. Good for allowlists, model rosters, feature flags.
   */
  list(suffix: string, fallback: readonly string[] = []): string[] {
    const v = this.raw(suffix);
    if (v === undefined) return [...fallback];
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * Filesystem path, resolved to an absolute path. A relative value is resolved
   * against the process cwd (matching how `core/config.ts` resolves its paths).
   * `fallback` may itself be relative (resolved the same way) or undefined.
   */
  path(suffix: string): string | undefined;
  path(suffix: string, fallback: string): string;
  path(suffix: string, fallback?: string): string | undefined {
    const v = this.raw(suffix) ?? fallback;
    if (v === undefined) return undefined;
    return isAbsolute(v) ? v : resolve(process.cwd(), v);
  }
}

/**
 * Build a config reader bound to one module's `IKBI_<MODULE>_` namespace. The
 * single entry point modules use to own their typed config slice (see file header).
 * `env` defaults to the frozen process-env snapshot; tests pass an arbitrary env.
 */
export function moduleEnv(module: string, env?: Readonly<NodeJS.ProcessEnv>): ModuleEnv {
  return new ModuleEnv(module, env);
}
