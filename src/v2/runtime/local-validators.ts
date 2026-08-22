/**
 * THE DETERMINISTIC VALIDATORS — what makes a task class eligible for local execution at all.
 *
 * A local worker's answer is untrusted text. What turns it into evidence is something that can
 * check it WITHOUT a language model: a required shape, a closed vocabulary, and — where the answer
 * claims to have read something — citations that resolve exactly against the packet the model was
 * given. A task class with no such check does not belong in the eligible list, however useful it
 * would be to offload.
 *
 * THEY ARE STRICT ON PURPOSE. Every artifact on the current deployment reports
 * INSTALLED_UNQUALIFIED, and the characteristic failure of an aggressively quantized worker is not
 * gibberish — it is a fluent, well-formatted answer about something it was never shown. A lenient
 * validator would pass exactly that. So the parse is narrow, the vocabulary is closed, and an
 * answer that will not fit is rejected rather than coerced into fitting.
 *
 * PARSING IS DELIBERATELY DUMB. The model is told to emit a single fenced JSON object. Anything
 * that requires cleverness to interpret is a thing we have decided to believe about a worker
 * nobody has vouched for.
 */

import type { LocalPacketItem, LocalValidator } from "./local-lane.js";

/** Pull the first JSON object out of the answer, whether or not it is fenced. */
function firstJsonObject(raw: string): unknown | undefined {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(raw);
  const candidate = fenced?.[1] ?? (() => {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? raw.slice(start, end + 1) : undefined;
  })();
  if (candidate === undefined) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);

/** Citations, read from a `citations: [{sourceId, quote}]` array. Absent means none claimed. */
function readCitations(raw: string): readonly { sourceId: string; quote: string }[] {
  const body = firstJsonObject(raw);
  if (!isObj(body) || !Array.isArray(body["citations"])) return [];
  const out: { sourceId: string; quote: string }[] = [];
  for (const c of body["citations"]) {
    if (!isObj(c)) continue;
    const sourceId = str(c["sourceId"]);
    const quote = str(c["quote"]);
    if (sourceId !== undefined && quote !== undefined) out.push({ sourceId, quote });
  }
  return out;
}

/**
 * Build a validator that requires a closed-vocabulary field plus at least one resolving citation.
 *
 * The citation requirement is what stops a confident guess from passing. A classification with no
 * quote behind it is the worker's opinion; with a quote that resolves, it is a reading of evidence
 * ikbi supplied — and ikbi can check which one it got.
 */
function classifier(name: string, field: string, vocabulary: readonly string[], requireCitation: boolean): LocalValidator {
  return {
    name,
    citations: readCitations,
    validate(raw: string, _packet: readonly LocalPacketItem[]) {
      const body = firstJsonObject(raw);
      if (!isObj(body)) return { ok: false as const, detail: "no JSON object found in the answer" };
      const value = str(body[field]);
      if (value === undefined) return { ok: false as const, detail: `missing "${field}"` };
      if (!vocabulary.includes(value)) {
        // A value outside the vocabulary is not a nuance; it is the model answering a different
        // question from the one it was asked.
        return { ok: false as const, detail: `"${field}" was ${JSON.stringify(value)}, which is not one of: ${vocabulary.join(", ")}` };
      }
      const citations = readCitations(raw);
      if (requireCitation && citations.length === 0) {
        return { ok: false as const, detail: "no citation supplied — an unsupported classification is an opinion" };
      }
      const summary = str(body["summary"]);
      return {
        ok: true as const,
        artifact: { [field]: value, ...(summary !== undefined ? { summary } : {}), citations },
      };
    },
  };
}

/** Free-form-but-cited summarization: the prose is the answer, the citations are the proof. */
function citedSummary(name: string, minCitations: number): LocalValidator {
  return {
    name,
    citations: readCitations,
    validate(raw: string) {
      const body = firstJsonObject(raw);
      if (!isObj(body)) return { ok: false as const, detail: "no JSON object found in the answer" };
      const summary = str(body["summary"]);
      if (summary === undefined) return { ok: false as const, detail: 'missing "summary"' };
      const citations = readCitations(raw);
      if (citations.length < minCitations) {
        return { ok: false as const, detail: `at least ${minCitations} resolving citation(s) required, got ${citations.length}` };
      }
      return { ok: true as const, artifact: { summary, citations } };
    },
  };
}

/**
 * A proposed narrow edit, returned as DATA.
 *
 * It carries no authority whatsoever: ikbi may later apply it through the ordinary governed
 * mutation path, with the ordinary verification in front of it, or may discard it. The validator's
 * job is only to ensure it is a well-formed PROPOSAL — a path, an exact anchor to replace, and a
 * replacement — rather than prose that someone would have to interpret before touching a file.
 */
const editProposal: LocalValidator = {
  name: "narrow-edit-proposal",
  citations: readCitations,
  validate(raw: string, packet: readonly LocalPacketItem[]) {
    const body = firstJsonObject(raw);
    if (!isObj(body)) return { ok: false as const, detail: "no JSON object found in the answer" };
    const path = str(body["path"]);
    const find = str(body["find"]);
    const replace = typeof body["replace"] === "string" ? (body["replace"] as string) : undefined;
    if (path === undefined) return { ok: false as const, detail: 'missing "path"' };
    if (find === undefined) return { ok: false as const, detail: 'missing "find" — an edit with no anchor is not narrow' };
    if (replace === undefined) return { ok: false as const, detail: 'missing "replace"' };

    // THE ANCHOR MUST EXIST IN THE PACKET, EXACTLY AND ONCE. A `find` the model invented would
    // make the proposal unappliable at best; one that matches twice would make it ambiguous, and
    // an ambiguous edit applied by a later pass is a change nobody chose.
    const item = packet.find((p) => p.id === path || p.id.endsWith(path));
    if (item === undefined) return { ok: false as const, detail: `"${path}" is not in the packet the worker was given` };
    const occurrences = item.content.split(find).length - 1;
    if (occurrences === 0) return { ok: false as const, detail: `the "find" anchor does not occur in ${path}` };
    if (occurrences > 1) return { ok: false as const, detail: `the "find" anchor occurs ${occurrences} times in ${path} — ambiguous` };

    return {
      ok: true as const,
      // `proposal` names it for what it is. Nothing downstream should be able to mistake this for
      // an applied change.
      artifact: { kind: "proposed_edit", path, find, replace, applied: false, citations: readCitations(raw) },
    };
  },
};

/** The validator for each eligible task class. The keys ARE the eligible list the CLI accepts. */
export const LOCAL_VALIDATORS = {
  test_log_triage: classifier(
    "test-log-triage",
    "category",
    ["assertion_failure", "compile_error", "timeout", "missing_dependency", "flaky", "environment", "unknown"],
    true,
  ),
  structured_classification: classifier("structured-classification", "label", ["yes", "no", "unknown"], true),
  diff_summarization: citedSummary("diff-summarization", 1),
  receipt_summarization: citedSummary("receipt-summarization", 1),
  repo_recon_bounded: citedSummary("repo-recon", 1),
  cited_extraction: citedSummary("cited-extraction", 1),
  transformation_proposal: citedSummary("transformation-proposal", 1),
  narrow_edit_proposal: editProposal,
} as const satisfies Record<string, LocalValidator>;

export type LocalValidatorName = keyof typeof LOCAL_VALIDATORS;
