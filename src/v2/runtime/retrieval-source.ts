/**
 * THE deterministic retrieval CONTEXT SOURCE — the one bridge from ranking to context.
 *
 * It enumerates the run's source through the `SourceSnapshotReader` and nothing else: no
 * `git ls-files`, no `find`, no `ripgrep --files`, no `readdirSync`. The snapshot remains
 * the only authority over what "the source" is, so a file created after capture is not
 * discoverable and a file deleted before capture cannot come back.
 *
 * IT DOES NOT RE-RANK. `rankFiles` in `core/retrieval.ts` decides the order; this module
 * reads bytes, applies the exclusion policy, converts the ranked result into candidates
 * and hands them to the assembler. Sorting or filtering by relevance here would create a
 * second, invisible ranking opinion — exactly the drift v2 exists to remove.
 *
 * IT DOES NOT ADMIT. Every candidate it offers may still be omitted for budget by
 * `assembleContext`, which is the only thing allowed to decide what the model receives.
 */

import {
  DEFAULT_RETRIEVAL_BUDGET,
  RETRIEVAL_ALGORITHM,
  excludePath,
  looksBinary,
  normalizeQuery,
  queryDigest,
  rankFiles,
  retrievalDigest,
  type RetrievableFile,
  type RetrievalBudget,
  type RetrievalCandidate,
  type RetrievalExclusion,
  type RetrievalResult,
} from "../core/retrieval.js";
import type { ContextCandidate, ContextOmission, ContextSource, ContextSourceRequest, ContextSourceResult } from "../core/context.js";
import type { RetrievalReporter } from "../core/retrieval.js";
import type { SourceSnapshotReader } from "../core/source.js";

/**
 * Per-file byte cap for a RETRIEVED artifact.
 *
 * Lower than the named-target cap on purpose: a retrieved file is a guess, and twenty
 * guesses must not consume the window a named file is entitled to. A truncated head is
 * still useful — imports, exports and the top of the implementation are what a builder
 * usually needs to decide whether the file matters.
 */
export const MAX_RETRIEVED_ARTIFACT_BYTES = 6_000;

/** The one retrieval source's id. Appears in every candidate's provenance. */
export const RETRIEVAL_SOURCE_ID = "retrieved_repository_evidence";

/**
 * Read every enumerable source file, applying the exclusion policy.
 *
 * Exclusions are RECORDED, not silently dropped: a run can always answer "why did you not
 * look at X?" with a reason from a closed vocabulary.
 */
async function readUniverse(
  reader: SourceSnapshotReader,
  budget: RetrievalBudget,
): Promise<{ files: RetrievableFile[]; exclusions: RetrievalExclusion[]; examined: number }> {
  const paths = await reader.list();
  const files: RetrievableFile[] = [];
  const exclusions: RetrievalExclusion[] = [];

  for (const path of paths) {
    // Cheap path-shape checks first, so most of a repository is skipped without I/O.
    const shapeExclusion = excludePath(path, 0, budget);
    if (shapeExclusion !== undefined) {
      exclusions.push({ path, reason: shapeExclusion });
      continue;
    }
    const outcome = await reader.read(path);
    if (!outcome.ok) {
      exclusions.push({ path, reason: "unreadable_in_snapshot" });
      continue;
    }
    if (outcome.byteLength > budget.maxFileBytes) {
      exclusions.push({ path, reason: "too_large" });
      continue;
    }
    if (looksBinary(outcome.content)) {
      exclusions.push({ path, reason: "binary" });
      continue;
    }
    files.push({ path, content: outcome.content, byteLength: outcome.byteLength, contentSha256: outcome.contentSha256 });
  }

  return { files, exclusions, examined: paths.length };
}

/** Render one ranked candidate as a context candidate, truncating at a UTF-8 boundary. */
function toContextCandidate(candidate: RetrievalCandidate, file: RetrievableFile): ContextCandidate {
  const bytes = Buffer.from(file.content, "utf8");
  const truncated = bytes.byteLength > MAX_RETRIEVED_ARTIFACT_BYTES;
  // `toString` on a byte slice cannot split a multi-byte character in the middle.
  const content = truncated ? bytes.subarray(0, MAX_RETRIEVED_ARTIFACT_BYTES).toString("utf8") : file.content;
  const why = candidate.reasons.map((r) => `${r.reason}×${r.hits}`).join(", ");
  return {
    category: "retrieved_repository_evidence",
    sourceId: RETRIEVAL_SOURCE_ID,
    path: candidate.path,
    origin: "repository",
    content,
    originalBytes: file.byteLength,
    truncated,
    // The digest is always of the WHOLE observed file, never of the truncated view, so it
    // stays comparable with an observation a later mutation authority takes.
    observedSha256: file.contentSha256,
    reason: `retrieved (rank ${candidate.rank}, score ${candidate.score}): ${why}`,
  };
}

/**
 * Build THE retrieval source.
 *
 * One per process. Exposed as a factory rather than a singleton so tests can pin a budget
 * without mutating shared state.
 */
export function createRetrievalSource(budget: RetrievalBudget = DEFAULT_RETRIEVAL_BUDGET): ContextSource & RetrievalReporter {
  // Per-instance, never module-global: one run's retrieval can never be reported as
  // another's, and nothing survives between runs to be stale.
  let last: RetrievalResult | undefined;

  return {
    id: RETRIEVAL_SOURCE_ID,

    lastResult: () => last,

    async collect(request: ContextSourceRequest): Promise<ContextSourceResult> {
      const query = normalizeQuery(request.goal);
      const snapshotId = request.source.snapshot.snapshotId;

      // A goal with no usable terms retrieves NOTHING rather than guessing. Offering the
      // repository's first N files would be noise dressed as evidence.
      if (query.pathTokens.length === 0 && query.terms.length === 0 && query.identifierParts.length === 0) {
        last = {
          retrievalId: retrievalDigest({ sourceSnapshotId: snapshotId, algorithm: RETRIEVAL_ALGORITHM, query, budget, candidates: [] }),
          sourceSnapshotId: snapshotId,
          algorithm: RETRIEVAL_ALGORITHM,
          queryDigest: queryDigest(query),
          query,
          candidates: [],
          examinedCount: 0,
          matchedCount: 0,
          exclusions: [],
          duplicatesSuppressed: [],
        };
        return { candidates: [], omissions: [] };
      }

      const universe = await readUniverse(request.source, budget);
      const alreadyOffered = new Set(request.alreadyOffered);

      // Rank EVERYTHING, then suppress what the higher bands already carry. Ranking first
      // means a suppressed file frees its slot for the next best one instead of leaving a
      // hole — the operator gets `maxCandidates` useful files, not `maxCandidates` minus
      // however many they happened to name.
      const ranked = rankFiles(universe.files, query, { ...budget, maxCandidates: budget.maxCandidates + alreadyOffered.size });
      const duplicatesSuppressed = ranked.filter((c) => alreadyOffered.has(c.path)).map((c) => c.path);
      const offered = ranked.filter((c) => !alreadyOffered.has(c.path)).slice(0, budget.maxCandidates);
      // Ranks are renumbered over what is actually offered, so rank 1 means "the best
      // thing this source contributed" rather than pointing at a suppressed file.
      const renumbered = offered.map((c, index) => ({ ...c, rank: index + 1 }));

      const byPath = new Map(universe.files.map((f) => [f.path, f]));
      const candidates = renumbered.map((c) => toContextCandidate(c, byPath.get(c.path)!));

      last = {
        retrievalId: retrievalDigest({ sourceSnapshotId: snapshotId, algorithm: RETRIEVAL_ALGORITHM, query, budget, candidates: renumbered }),
        sourceSnapshotId: snapshotId,
        algorithm: RETRIEVAL_ALGORITHM,
        queryDigest: queryDigest(query),
        query,
        candidates: renumbered,
        examinedCount: universe.examined,
        matchedCount: ranked.length,
        exclusions: universe.exclusions,
        duplicatesSuppressed,
      };

      // Suppressed duplicates are reported as omissions rather than vanishing: the
      // manifest should say the file was found AND why it was not sent twice.
      const omissions: ContextOmission[] = duplicatesSuppressed.map((path) => ({
        category: "retrieved_repository_evidence" as const,
        sourceId: RETRIEVAL_SOURCE_ID,
        path,
        reason: "duplicate" as const,
        detail: "a higher-priority context source already provided this file",
      }));

      return { candidates, omissions };
    },
  };
}
