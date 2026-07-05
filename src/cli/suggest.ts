/**
 * ikbi CLI — "did you mean" command suggestion (LOW: typo help).
 *
 * A mistyped command (`ikbi buld`) otherwise silently opens the REPL with the typo as its first chat
 * message. `suggestCommand` turns it into a "did you mean `build`?" hint. Pure + dependency-free (the
 * caller supplies the known-command list), so it is unit-testable without booting the CLI.
 */

/** Levenshtein edit distance (bounded small inputs — command names). */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * The closest command in `known` to `cmd` within `maxDist` edits, or undefined. First letters must
 * match (typos rarely change the first char), which cuts false matches like `fix`→`six`. The caller
 * picks `maxDist`: tight (1) for a lone bare word that could be REPL prose, looser (2) when a flag
 * betrays clear command intent.
 */
export function suggestCommand(cmd: string, known: readonly string[], maxDist: number): string | undefined {
  let best: string | undefined;
  let bestDist = maxDist + 1;
  for (const name of known) {
    if (name[0] !== cmd[0]) continue;
    const d = editDistance(cmd, name);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return bestDist <= maxDist ? best : undefined;
}
