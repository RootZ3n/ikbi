/**
 * ikbi model-evaluation — the LUAK BENCHMARK ADAPTER.
 *
 * ikbi's competitive-build shootout and per-role model choice (IKBI_MODEL_DRIVER/_BUILDER/…)
 * are static and hand-tuned. This adapter makes cold model selection BENCHMARK-DRIVEN: it pulls
 * Luak's public leaderboard (the lab's scoreboard/evidence service) and ranks the roster's
 * candidate models by their measured quality, so a competitive race seeds from data instead of a
 * guess — and so an operator can pick the CHEAPEST model above a quality threshold for a role.
 *
 * Pure ranking (`rankCandidates`, `pickCheapestAboveThreshold`) is deterministic and network-free
 * (unit-tested); only `fetchLuakLeaderboard` touches the wire, with an injectable fetch + timeout
 * and uniform error mapping. Reaching Luak goes through ikbi's egress guard — a denial is surfaced
 * with the allowlist guidance, never a silent empty leaderboard.
 *
 * @status library-only — exported + tested; surfaced via `ikbi models --rank`.
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("model-evaluation");

/** Default Luak base URL (the lab's canonical Luak port). */
export const DEFAULT_LUAK_URL = "http://127.0.0.1:18795";
/** Default leaderboard endpoint path on Luak. */
export const DEFAULT_LUAK_PATH = "/api/leaderboard";
/** Default per-request budget (ms). */
export const DEFAULT_LUAK_TIMEOUT_MS = 15_000;

export interface LuakAdapterConfig {
  readonly url: string;
  readonly path: string;
  readonly token: string | undefined;
  readonly timeoutMs: number;
}

/** Load the Luak-adapter config slice from `IKBI_MODEL_EVALUATION_LUAK_*`. */
export function loadLuakAdapterConfig(reader = env): LuakAdapterConfig {
  const url = reader.str("LUAK_URL", DEFAULT_LUAK_URL).replace(/\/+$/, "");
  const path = reader.str("LUAK_PATH", DEFAULT_LUAK_PATH);
  return Object.freeze({
    url,
    path: path.startsWith("/") ? path : `/${path}`,
    token: reader.str("LUAK_TOKEN", "") || undefined,
    timeoutMs: reader.int("LUAK_TIMEOUT_MS", DEFAULT_LUAK_TIMEOUT_MS, { min: 1 }),
  });
}

/** One Luak leaderboard row (the fields this adapter reads; Luak returns more). */
export interface LuakLeaderboardEntry {
  readonly modelId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly composite?: number;
  readonly average_pass_rate?: number;
  readonly reliability_score?: number;
}

/** A roster model reduced to what ranking needs (decoupled from the provider registry's ModelSpec). */
export interface RosterModel {
  readonly id: string;
  readonly role?: string | undefined;
  /** Blended $/Mtok used as a cheapness tie-break and for "cheapest above threshold". */
  readonly costPerMTok?: number | undefined;
  /** Provider-side model ids (e.g. "deepseek-chat") — alternate keys to match against Luak. */
  readonly providerModelIds?: readonly string[];
}

export interface RankCandidate {
  readonly id: string;
  readonly role?: string | undefined;
  readonly matched?: LuakLeaderboardEntry | undefined;
  /** The quality score used for ranking (higher = better); undefined when no Luak data matched. */
  readonly score?: number | undefined;
  readonly costPerMTok?: number | undefined;
}

/** A minimal fetch surface so tests inject a fake without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Normalize a model name for fuzzy matching: lowercase, drop everything but alphanumerics. */
export function normalizeModelName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The score a Luak entry contributes: reliability > composite > average_pass_rate. */
export function scoreOfEntry(e: LuakLeaderboardEntry): number | undefined {
  if (typeof e.reliability_score === "number") return e.reliability_score;
  if (typeof e.composite === "number") return e.composite;
  if (typeof e.average_pass_rate === "number") return e.average_pass_rate;
  return undefined;
}

/** Find the best Luak entry for a roster model (by id or any provider-side id), or undefined. */
export function matchLuakEntry(model: RosterModel, entries: readonly LuakLeaderboardEntry[]): LuakLeaderboardEntry | undefined {
  const keys = [model.id, ...(model.providerModelIds ?? [])].map(normalizeModelName).filter((k) => k.length > 0);
  let best: { entry: LuakLeaderboardEntry; score: number } | undefined;
  for (const e of entries) {
    const names = [e.modelId, e.model].filter((n): n is string => typeof n === "string" && n.length > 0).map(normalizeModelName);
    const hit = names.some((n) => keys.some((k) => n === k || n.includes(k) || k.includes(n)));
    if (!hit) continue;
    const s = scoreOfEntry(e) ?? -Infinity;
    if (best === undefined || s > best.score) best = { entry: e, score: s };
  }
  return best?.entry;
}

/**
 * Rank roster models by their measured Luak quality. Matched models sort by score DESC; ties
 * break to the cheaper model; UNMATCHED models (no Luak evidence) sort last (stable by input order).
 */
export function rankCandidates(models: readonly RosterModel[], entries: readonly LuakLeaderboardEntry[]): RankCandidate[] {
  const candidates: RankCandidate[] = models.map((m) => {
    const matched = matchLuakEntry(m, entries);
    return {
      id: m.id,
      role: m.role,
      matched,
      score: matched !== undefined ? scoreOfEntry(matched) : undefined,
      costPerMTok: m.costPerMTok,
    };
  });
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const sa = a.c.score ?? -Infinity;
      const sb = b.c.score ?? -Infinity;
      if (sb !== sa) return sb - sa;
      const ca = a.c.costPerMTok ?? Infinity;
      const cb = b.c.costPerMTok ?? Infinity;
      if (ca !== cb) return ca - cb;
      return a.i - b.i; // stable
    })
    .map(({ c }) => c);
}

/** The inclusive bounds a `--min-score` value must fall within (Luak scores are normalized 0–1). */
export const MIN_SCORE_LOWER = 0;
export const MIN_SCORE_UPPER = 1;

export type MinScoreResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a raw `--min-score` argument (RC4). Luak scores are normalized 0–1, so a value must be
 * a finite number in [0, 1]. Rejects NaN / non-numbers, negatives, and over-max (the common 0–100
 * mistake, e.g. `70`) with a clear, actionable message — instead of silently filtering everything.
 */
export function validateMinScore(raw: string | undefined): MinScoreResult {
  if (raw === undefined || raw.trim().length === 0) {
    return { ok: false, error: `--min-score expects a number between ${MIN_SCORE_LOWER} and ${MIN_SCORE_UPPER} (got no value)` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_SCORE_LOWER || value > MIN_SCORE_UPPER) {
    return {
      ok: false,
      error:
        `--min-score expects a number between ${MIN_SCORE_LOWER} and ${MIN_SCORE_UPPER} ` +
        `(Luak scores are normalized 0–1; e.g. 0.7 for "70%"); got "${raw}"`,
    };
  }
  return { ok: true, value };
}

/**
 * Pick the CHEAPEST candidate whose score meets `minScore`. Returns undefined when none qualify
 * (e.g. no Luak data, or every match is below threshold) — the caller falls back to the static pick.
 */
export function pickCheapestAboveThreshold(candidates: readonly RankCandidate[], minScore: number): RankCandidate | undefined {
  const qualified = candidates.filter((c) => typeof c.score === "number" && c.score >= minScore);
  if (qualified.length === 0) return undefined;
  return [...qualified].sort((a, b) => (a.costPerMTok ?? Infinity) - (b.costPerMTok ?? Infinity))[0];
}

export type LuakFetchResult =
  | { readonly ok: true; readonly entries: LuakLeaderboardEntry[] }
  | { readonly ok: false; readonly error: string };

/** Fetch + parse Luak's leaderboard. Never throws — failures become a structured error result. */
export async function fetchLuakLeaderboard(
  cfg: LuakAdapterConfig = loadLuakAdapterConfig(),
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<LuakFetchResult> {
  const url = `${cfg.url}${cfg.path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.token !== undefined) headers["authorization"] = `Bearer ${cfg.token}`;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/egress|allowlist|blocked|SSRF/i.test(detail)) {
      return { ok: false, error: `${detail} — add Luak's host to IKBI_EGRESS_ALLOWLIST (and its ip:port to IKBI_EGRESS_ALLOW_LOCAL for a loopback Luak)` };
    }
    if (err instanceof Error && err.name === "TimeoutError") return { ok: false, error: `Luak did not respond within ${cfg.timeoutMs}ms (${url})` };
    return { ok: false, error: `cannot reach Luak at ${url} (${detail})` };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: `Luak returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };

  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error: "Luak returned a non-JSON body" };
  }
  return { ok: true, entries: parseLeaderboardEntries(body) };
}

/** Accept either `{ leaderboard: [...] }` or a bare array of entries. */
export function parseLeaderboardEntries(body: unknown): LuakLeaderboardEntry[] {
  const arr =
    Array.isArray(body) ? body
    : body !== null && typeof body === "object" && Array.isArray((body as Record<string, unknown>).leaderboard)
      ? ((body as Record<string, unknown>).leaderboard as unknown[])
      : [];
  return arr.filter((e): e is LuakLeaderboardEntry => e !== null && typeof e === "object");
}
