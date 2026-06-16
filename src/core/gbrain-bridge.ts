/**
 * ikbi core — gbrain BRIDGE (the intelligence layer for ikbi's memory system).
 *
 * gbrain (https://github.com/…/gbrain) is a personal knowledge brain: a PGLite/Supabase
 * store with hybrid (vector + keyword) retrieval and multi-hop synthesis. This bridge lets
 * ikbi *consult* and *feed* that brain WITHOUT pulling gbrain in as a dependency — we shell
 * the installed `gbrain` CLI through `execFileSync` (ARRAY args — NEVER a shell string, so a
 * query/slug can't inject a command) and parse its JSON.
 *
 * GUARANTEES (the contract callers rely on):
 *   - EVERY invocation is bounded by a 30s wall-clock timeout (DEFAULT_TIMEOUT_MS).
 *   - `~/.bun/bin` is prepended to PATH (gbrain installs there under bun) so the CLI resolves
 *     even when ikbi runs from a service context with a thin PATH.
 *   - On any failure (missing binary, non-zero exit, timeout, lock contention) a typed
 *     `GbrainError` is thrown carrying the stderr/exit code — callers decide fail-open vs
 *     fail-closed. The "best-effort" surface (`projectContext`) swallows these so a build is
 *     NEVER blocked by an unavailable brain.
 *
 * TRUST: everything gbrain returns is retrieved KNOWLEDGE — UNTRUSTED data. This module only
 * PRODUCES strings/objects; callers (the builder tools, the context loader) route the output
 * through ikbi's neutralization chokepoint exactly like read_file / search_files output.
 *
 * TESTABILITY: the exec primitive is injectable (`GbrainDeps.execFileSync`) so the unit tests
 * mock it — no real brain, no real CLI, fully deterministic.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { configEnv } from "./config.js";

/** Default wall-clock budget for a single gbrain invocation. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Cap on captured stdout (defense-in-depth: a runaway brain dump can't blow up memory). */
const MAX_OUTPUT_BYTES = 1_000_000;

/** The exact `execFileSync` subset this bridge uses — injectable so tests can mock it. */
export type ExecFileSyncFn = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly env: NodeJS.ProcessEnv;
    readonly input?: string;
  },
) => string;

/** Injectable dependencies + overrides (all optional; sensible production defaults). */
export interface GbrainDeps {
  /** The exec primitive (default: node's `execFileSync`). Tests inject a fake. */
  readonly execFileSync?: ExecFileSyncFn;
  /** The gbrain binary name/path (default: "gbrain", resolved via the augmented PATH). */
  readonly binary?: string;
  /** Per-call timeout in ms (default: {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Home directory used to locate `~/.bun/bin` (default: `$HOME` / os.homedir()). */
  readonly homeDir?: string;
}

/** A typed gbrain failure: the binary, args, exit code and stderr are preserved for triage. */
export class GbrainError extends Error {
  /** The gbrain sub-command that failed (e.g. "search", "put"). */
  readonly command: string;
  /** Process exit code, when the failure was a non-zero exit (undefined for spawn errors). */
  readonly exitCode: number | undefined;
  /** Captured stderr (trimmed/bounded), when available. */
  readonly stderr: string | undefined;

  constructor(command: string, message: string, opts?: { exitCode?: number | undefined; stderr?: string | undefined; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GbrainError";
    this.command = command;
    this.exitCode = opts?.exitCode;
    this.stderr = opts?.stderr;
  }
}

/** A single hit from `gbrain search` / `query`, normalized to the fields ikbi consumes. */
export interface BrainSearchHit {
  readonly slug?: string;
  readonly title?: string;
  readonly score?: number;
  readonly snippet?: string;
  readonly content?: string;
  /** Anything else gbrain returned, preserved verbatim. */
  readonly [key: string]: unknown;
}

/** Result of {@link GbrainBridge.searchBrain}. `raw` is the unparsed CLI stdout. */
export interface BrainSearchResult {
  readonly hits: readonly BrainSearchHit[];
  readonly raw: string;
}

/** Result of {@link GbrainBridge.thinkBrain}: a synthesized answer plus any structured payload. */
export interface BrainThinkResult {
  /** The synthesized answer text (best-effort extracted from JSON, else the raw stdout). */
  readonly answer: string;
  /** The parsed JSON payload, when gbrain emitted JSON. */
  readonly json?: unknown;
  readonly raw: string;
}

/** Result of {@link GbrainBridge.syncProject}: the import + embed stdout, for receipts/logs. */
export interface BrainSyncResult {
  readonly imported: string;
  readonly embedded: string;
}

/** The bridge surface. */
export interface GbrainBridge {
  searchBrain(query: string, opts?: { limit?: number }): BrainSearchResult;
  thinkBrain(question: string): BrainThinkResult;
  putPage(slug: string, content: string): string;
  syncProject(projectPath: string): BrainSyncResult;
  /** Best-effort, bounded knowledge block for a goal — returns undefined instead of throwing. */
  projectContext(query: string, opts?: { limit?: number; maxBytes?: number }): string | undefined;
}

/** Build the augmented environment: `~/.bun/bin` prepended to PATH so `gbrain` resolves. */
function gbrainEnv(homeDir: string): NodeJS.ProcessEnv {
  const bunBin = join(homeDir, ".bun", "bin");
  const currentPath = configEnv.PATH ?? "";
  const path = currentPath.length > 0 ? `${bunBin}:${currentPath}` : bunBin;
  return { ...configEnv, PATH: path };
}

/** Parse JSON defensively: returns the value, or undefined if the text is not JSON. */
function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Normalize a parsed search payload (array | {results:[]} | {hits:[]}) into hits. */
function normalizeHits(parsed: unknown): readonly BrainSearchHit[] {
  if (Array.isArray(parsed)) return parsed as BrainSearchHit[];
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["results", "hits", "matches", "pages"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as BrainSearchHit[];
    }
  }
  return [];
}

/**
 * Create a gbrain bridge bound to `deps`. Production callers use the default singleton
 * exports below; tests construct one with a mocked `execFileSync`.
 */
export function createGbrainBridge(deps: GbrainDeps = {}): GbrainBridge {
  const exec = deps.execFileSync ?? (execFileSync as unknown as ExecFileSyncFn);
  const binary = deps.binary ?? "gbrain";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const homeDir = deps.homeDir ?? configEnv.HOME ?? homedir();
  const env = gbrainEnv(homeDir);

  /** Run one gbrain sub-command. Throws {@link GbrainError} on any failure. ALWAYS bounded. */
  const run = (command: string, args: readonly string[], input?: string): string => {
    try {
      const out = exec(binary, [command, ...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env,
        ...(input !== undefined ? { input } : {}),
      });
      return typeof out === "string" ? out : String(out);
    } catch (e) {
      const err = e as { code?: unknown; status?: unknown; stderr?: unknown; signal?: unknown; message?: unknown };
      const stderr = typeof err.stderr === "string" ? err.stderr.trim().slice(0, 4_000) : undefined;
      const exitCode = typeof err.status === "number" ? err.status : undefined;
      // ENOENT ⇒ the gbrain binary isn't installed / not on the augmented PATH.
      if (err.code === "ENOENT") {
        throw new GbrainError(command, `gbrain CLI not found (looked for "${binary}" on PATH including ~/.bun/bin). Is gbrain installed?`, { cause: e });
      }
      // SIGTERM from execFileSync ⇒ the 30s timeout fired (or a PGLite lock stall).
      if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
        throw new GbrainError(command, `gbrain ${command} timed out after ${timeoutMs}ms`, { exitCode, stderr, cause: e });
      }
      const detail = stderr !== undefined && stderr.length > 0 ? stderr : typeof err.message === "string" ? err.message : "unknown error";
      throw new GbrainError(command, `gbrain ${command} failed${exitCode !== undefined ? ` (exit ${exitCode})` : ""}: ${detail}`, { exitCode, stderr, cause: e });
    }
  };

  const searchBrain: GbrainBridge["searchBrain"] = (query, opts) => {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new GbrainError("search", "searchBrain requires a non-empty query");
    }
    const args = [query, "--json"];
    if (opts?.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
      args.push("--limit", String(Math.floor(opts.limit)));
    }
    const raw = run("search", args);
    return { hits: normalizeHits(tryParseJson(raw)), raw };
  };

  const thinkBrain: GbrainBridge["thinkBrain"] = (question) => {
    if (typeof question !== "string" || question.trim().length === 0) {
      throw new GbrainError("think", "thinkBrain requires a non-empty question");
    }
    const raw = run("think", [question, "--json"]);
    const json = tryParseJson(raw);
    let answer = raw.trim();
    if (json !== null && typeof json === "object") {
      const obj = json as Record<string, unknown>;
      for (const key of ["answer", "text", "synthesis", "response"]) {
        if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
          answer = obj[key] as string;
          break;
        }
      }
    }
    return { answer, json, raw };
  };

  const putPage: GbrainBridge["putPage"] = (slug, content) => {
    if (typeof slug !== "string" || slug.trim().length === 0) {
      throw new GbrainError("put", "putPage requires a non-empty slug");
    }
    if (typeof content !== "string") {
      throw new GbrainError("put", "putPage requires string content");
    }
    // gbrain put <slug> reads the page body from STDIN (`gbrain put <slug> < file.md`).
    return run("put", [slug], content).trim();
  };

  const syncProject: GbrainBridge["syncProject"] = (projectPath) => {
    if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
      throw new GbrainError("import", "syncProject requires a non-empty projectPath");
    }
    // import embeds by default; the explicit `embed --stale` pass is a no-op when nothing is
    // stale, but guarantees the "import + embed" contract even if import was run with --no-embed.
    const imported = run("import", [projectPath]).trim();
    const embedded = run("embed", ["--stale"]).trim();
    return { imported, embedded };
  };

  const projectContext: GbrainBridge["projectContext"] = (query, opts) => {
    const maxBytes = opts?.maxBytes ?? 8_000;
    try {
      const { hits } = searchBrain(query, { limit: opts?.limit ?? 5 });
      if (hits.length === 0) return undefined;
      const lines: string[] = [];
      for (const h of hits) {
        const title = typeof h.title === "string" && h.title.length > 0 ? h.title : typeof h.slug === "string" ? h.slug : "(untitled)";
        const body = typeof h.snippet === "string" && h.snippet.length > 0 ? h.snippet : typeof h.content === "string" ? h.content : "";
        const entry = body.length > 0 ? `- ${title}: ${body.replace(/\s+/g, " ").trim()}` : `- ${title}`;
        lines.push(entry);
      }
      const block = lines.join("\n").slice(0, maxBytes);
      return block.length > 0 ? block : undefined;
    } catch {
      // BEST-EFFORT: an unavailable/locked brain must NEVER block a build.
      return undefined;
    }
  };

  return { searchBrain, thinkBrain, putPage, syncProject, projectContext };
}

/** The default production bridge (real `execFileSync`, real `gbrain`, 30s timeout). */
export const gbrainBridge: GbrainBridge = createGbrainBridge();

export const searchBrain = gbrainBridge.searchBrain;
export const thinkBrain = gbrainBridge.thinkBrain;
export const putPage = gbrainBridge.putPage;
export const syncProject = gbrainBridge.syncProject;
export const projectContext = gbrainBridge.projectContext;
