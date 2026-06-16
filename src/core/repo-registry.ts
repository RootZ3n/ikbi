/**
 * ikbi repo registry — maps short repo names to absolute paths.
 *
 * Loads from `<stateRoot>/repos.json` at startup. The CLI `--repo` flag
 * resolves through this registry so operators can write `--repo toba`
 * instead of `--repo /path/to/toba`.
 *
 * The `repos` CLI command lists all registered repos.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { config } from "./config.js";

/** A single registered repo. */
export interface RepoEntry {
  readonly path: string;
  readonly description: string;
  readonly port?: number;
}

/** The full registry shape on disk. */
interface RepoRegistryFile {
  repos: Record<string, RepoEntry>;
}

/** Loaded, validated, immutable registry. */
export interface RepoRegistry {
  /** Resolve a name or path to an absolute repo path. Returns undefined if not found. */
  resolve(nameOrPath: string): string | undefined;
  /** List all registered repos. */
  list(): ReadonlyArray<{ name: string } & RepoEntry>;
  /** Check if a name is a registered repo alias. */
  has(name: string): boolean;
}

let cached: RepoRegistry | undefined;
let cachedRoot: string | undefined;

/** Load the repo registry from disk. Cached after first load for the same stateRoot. */
export function loadRepoRegistry(stateRoot?: string): RepoRegistry {
  const root = stateRoot ?? config.stateRoot;
  if (cached !== undefined && cachedRoot === root) return cached;

  const filePath = join(root, "repos.json");
  if (!existsSync(filePath)) {
    cached = emptyRegistry();
    cachedRoot = root;
    return cached;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as RepoRegistryFile;
    const entries = new Map<string, RepoEntry>();

    for (const [name, entry] of Object.entries(data.repos ?? {})) {
      if (typeof entry?.path === "string" && entry.path.length > 0) {
        if (!isAbsolute(entry.path)) {
          throw new Error(`repo "${name}" path must be absolute`);
        }
        entries.set(name.toLowerCase(), { ...entry, path: entry.path });
      }
    }

    cached = {
      resolve(nameOrPath: string): string | undefined {
        // If it's already an absolute path that exists, use it directly
        if (isAbsolute(nameOrPath)) return nameOrPath;
        // Look up in registry (case-insensitive)
        const entry = entries.get(nameOrPath.toLowerCase());
        return entry?.path;
      },

      list(): ReadonlyArray<{ name: string } & RepoEntry> {
        return [...entries.entries()].map(([name, entry]) => ({ name, ...entry }));
      },

      has(name: string): boolean {
        return entries.has(name.toLowerCase());
      },
    };
  } catch (e) {
    // L1: a malformed repos.json silently loaded zero repos — surface it so a typo'd registry
    // is diagnosable instead of looking like "no repos registered".
    process.stderr.write(`ikbi: failed to parse repo registry at ${filePath}: ${e instanceof Error ? e.message : String(e)} — loading empty registry\n`);
    cached = emptyRegistry();
  }

  cachedRoot = root;
  return cached;
}

function emptyRegistry(): RepoRegistry {
  return {
    resolve: (p) => (isAbsolute(p) ? p : undefined),
    list: () => [],
    has: () => false,
  };
}

/** Reset the cached registry (for testing). */
export function resetRepoRegistry(): void {
  cached = undefined;
  cachedRoot = undefined;
}
