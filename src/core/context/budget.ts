/**
 * ikbi context budget — a hard token budget with relevance-based eviction.
 *
 * The model's context window is finite, so context loading is a knapsack: admit the most
 * relevant files until the budget is spent, and when a newly-relevant file won't fit, evict
 * the COLDEST currently-admitted entries (lowest relevance, then least-recently/least-used)
 * to make room — but only if the newcomer is actually more relevant than what it displaces.
 * "Hot" files (frequently touched) accrue a recency bonus so they survive eviction.
 */

/** A file currently admitted to the budget. */
export interface BudgetEntry {
  readonly path: string;
  /** Estimated token cost of this file's content. */
  readonly tokens: number;
  /** Relevance score at admission (or last refresh). Higher = keep. */
  relevance: number;
  /** Access count — drives the "hot file" bonus used during eviction. */
  hits: number;
}

/** Rough token estimate from a character count (~4 chars/token, the common heuristic). */
export function estimateTokens(input: string | number): number {
  const chars = typeof input === "number" ? input : input.length;
  return Math.max(0, Math.ceil(chars / 4));
}

/** The effective "keep" weight of an entry: relevance plus a small bonus for being hot. */
function keepScore(e: BudgetEntry): number {
  return e.relevance + Math.min(e.hits, 10) * 0.05;
}

export class ContextBudget {
  readonly maxTokens: number;
  private readonly map = new Map<string, BudgetEntry>();
  private usedTokens = 0;

  constructor(maxTokens: number) {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new Error(`ContextBudget: maxTokens must be a positive number (got ${maxTokens})`);
    }
    this.maxTokens = Math.floor(maxTokens);
  }

  used(): number {
    return this.usedTokens;
  }

  remaining(): number {
    return this.maxTokens - this.usedTokens;
  }

  has(path: string): boolean {
    return this.map.has(path);
  }

  entries(): readonly BudgetEntry[] {
    return [...this.map.values()];
  }

  /** Mark a file as accessed (hot). Increments its hit count; no-op if not admitted. */
  touch(path: string): void {
    const e = this.map.get(path);
    if (e !== undefined) e.hits += 1;
  }

  /**
   * Try to admit a file at the given token cost and relevance. If it already fits, admit it.
   * If not, evict the coldest entries (lowest keepScore) that are LESS relevant than the
   * newcomer until it fits. Returns true if admitted; false if it could not be made to fit
   * (too large for the whole budget, or everything in the way is more relevant than it).
   *
   * Re-admitting an already-present path refreshes its relevance to the max of old/new and
   * counts as a touch — it never double-charges the budget.
   */
  admit(path: string, tokens: number, relevance: number): boolean {
    const cost = Math.max(0, Math.floor(tokens));
    const existing = this.map.get(path);
    if (existing !== undefined) {
      existing.relevance = Math.max(existing.relevance, relevance);
      existing.hits += 1;
      return true;
    }
    if (cost > this.maxTokens) return false; // can never fit, even in an empty budget

    if (cost <= this.remaining()) {
      this.map.set(path, { path, tokens: cost, relevance, hits: 0 });
      this.usedTokens += cost;
      return true;
    }

    // Need room. Consider evicting strictly-colder entries, coldest first.
    const evictable = this.entries()
      .filter((e) => keepScore(e) < relevance)
      .sort((a, b) => keepScore(a) - keepScore(b));
    let freed = this.remaining();
    const toEvict: string[] = [];
    for (const e of evictable) {
      if (freed >= cost) break;
      toEvict.push(e.path);
      freed += e.tokens;
    }
    if (freed < cost) return false; // even evicting all colder entries isn't enough

    for (const p of toEvict) this.evict(p);
    this.map.set(path, { path, tokens: cost, relevance, hits: 0 });
    this.usedTokens += cost;
    return true;
  }

  /** Remove a file from the budget, reclaiming its tokens. Returns the evicted entry, if any. */
  evict(path: string): BudgetEntry | undefined {
    const e = this.map.get(path);
    if (e === undefined) return undefined;
    this.map.delete(path);
    this.usedTokens -= e.tokens;
    return e;
  }

  /** Evict the single coldest entry (lowest keepScore). Returns it, or undefined if empty. */
  evictColdest(): BudgetEntry | undefined {
    let coldest: BudgetEntry | undefined;
    for (const e of this.map.values()) {
      if (coldest === undefined || keepScore(e) < keepScore(coldest)) coldest = e;
    }
    if (coldest === undefined) return undefined;
    return this.evict(coldest.path);
  }
}
