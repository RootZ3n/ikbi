/**
 * ikbi v2 — THE BUILDER TOOL CONTRACT.
 *
 * The builder's entire ability to affect anything is this file's vocabulary. It is
 * deliberately tiny — five tools — because the point of V2-007 is not breadth but
 * TRUSTWORTHY EDITING: every read produces an observation held by the mutation authority,
 * and every write must name the observation that authorized it.
 *
 * THE INVARIANT THE SCHEMAS ENFORCE: NO OBSERVATION → NO WRITE.
 *
 * `observationId` is REQUIRED on replace, create and delete. Not optional-with-a-default,
 * not "path only when the file is new" — creation is the case where a path-only escape
 * hatch is most tempting and most damaging, because "create" against a path that already
 * has content is a silent truncation. Making the model observe the MISSING state first
 * costs one turn and makes the compare-and-swap total.
 *
 * WHAT IS NOT HERE, AND WHY. No terminal, no patch/multi-edit, no git, no delegate, no
 * network, no package installation. A shell would let `sed -i` write files outside the
 * mutation authority, which is not a tool gap but an architectural bypass; the rest are
 * capability the builder does not need to prove it can edit code. They are candidates for
 * later slices, through this same contract.
 *
 * This file is PURE: schemas, argument parsing, and the exact text the model gets back.
 * It performs no I/O and holds no capability. See `runtime/builder-tools.ts` for the
 * executor that actually holds the authorities.
 */

import type { V2ObservationDigest } from "./identity.js";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const TOOL_READ_FILE = "read_file";
export const TOOL_REPLACE_FILE = "replace_file";
export const TOOL_CREATE_FILE = "create_file";
export const TOOL_DELETE_FILE = "delete_file";
export const TOOL_FINISH_CANDIDATE = "finish_candidate";

/** Every tool the builder may call. A name outside this set is a structural failure. */
export const BUILDER_TOOL_NAMES = [
  TOOL_READ_FILE,
  TOOL_REPLACE_FILE,
  TOOL_CREATE_FILE,
  TOOL_DELETE_FILE,
  TOOL_FINISH_CANDIDATE,
] as const;

export type BuilderToolName = (typeof BUILDER_TOOL_NAMES)[number];

export function isBuilderToolName(name: string): name is BuilderToolName {
  return (BUILDER_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A tool as the model is told about it. JSON Schema, provider-native. */
export interface BuilderToolDefinition {
  readonly name: BuilderToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

const stringProp = (description: string): Record<string, unknown> => ({ type: "string", description });

/**
 * The tool definitions, in the order the model sees them.
 *
 * Each description states the CONTRACT, not just the mechanic — a model that is told
 * "you must read before you write" behaves better than one that discovers it by being
 * refused, and being refused still works when it does not.
 */
export const BUILDER_TOOLS: readonly BuilderToolDefinition[] = Object.freeze([
  {
    name: TOOL_READ_FILE,
    description:
      "Read one file in your workspace and receive an observationId for its exact current state. " +
      "You MUST call this before any write to that path, including a path you believe does not exist yet — " +
      "reading a missing path is how you obtain the observationId that authorizes creating it.",
    parameters: {
      type: "object",
      properties: { path: stringProp("Workspace-relative path, e.g. src/widget.ts") },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_REPLACE_FILE,
    description:
      "Replace a file's entire contents. Requires the observationId from your most recent read_file of that path. " +
      "If the file changed since you read it, this is REFUSED and nothing is written — read it again and decide what to do. " +
      "Supply the complete resulting file, not a diff or a fragment.",
    parameters: {
      type: "object",
      properties: {
        path: stringProp("Workspace-relative path"),
        observationId: stringProp("The observationId returned by read_file for this exact path"),
        content: stringProp("The COMPLETE new contents of the file"),
      },
      required: ["path", "observationId", "content"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_CREATE_FILE,
    description:
      "Create a new file. Requires the observationId from a read_file that reported the path as MISSING. " +
      "If something exists there now, this is refused — use replace_file instead.",
    parameters: {
      type: "object",
      properties: {
        path: stringProp("Workspace-relative path"),
        observationId: stringProp("The observationId from a read_file that reported this path missing"),
        content: stringProp("The complete contents of the new file"),
      },
      required: ["path", "observationId", "content"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_DELETE_FILE,
    description:
      "Delete a file. Requires the observationId from your most recent read_file of that path.",
    parameters: {
      type: "object",
      properties: {
        path: stringProp("Workspace-relative path"),
        observationId: stringProp("The observationId returned by read_file for this exact path"),
      },
      required: ["path", "observationId"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_FINISH_CANDIDATE,
    description:
      "Declare that your work is complete. This is the ONLY way to finish — stopping without calling it is treated as an incomplete build. " +
      "Your summary is recorded as YOUR CLAIM. Do not claim the work is tested, verified or correct: a separate authority checks that afterwards, " +
      "and stating a verdict here does not make one.",
    parameters: {
      type: "object",
      properties: {
        summary: stringProp("What you changed and why, in a few sentences"),
        believesComplete: {
          type: "boolean",
          description: "Whether you believe the requested work is complete. Your belief, not a verdict.",
        },
      },
      required: ["summary", "believesComplete"],
      additionalProperties: false,
    },
  },
]);

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** A tool call as it came off the wire. Arguments are the model's raw JSON string. */
export interface BuilderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** The parsed, validated arguments of one call — or the reason it could not be used. */
export type ParsedToolCall =
  | { readonly ok: true; readonly name: typeof TOOL_READ_FILE; readonly path: string }
  | {
      readonly ok: true;
      readonly name: typeof TOOL_REPLACE_FILE | typeof TOOL_CREATE_FILE;
      readonly path: string;
      readonly observationId: V2ObservationDigest;
      readonly content: string;
    }
  | { readonly ok: true; readonly name: typeof TOOL_DELETE_FILE; readonly path: string; readonly observationId: V2ObservationDigest }
  | { readonly ok: true; readonly name: typeof TOOL_FINISH_CANDIDATE; readonly summary: string; readonly believesComplete: boolean }
  | { readonly ok: false; readonly reason: ToolRejectionReason; readonly detail: string };

/** Why a call could not even be attempted. Closed set — every refusal is explainable. */
export type ToolRejectionReason = "unknown_tool" | "malformed_arguments" | "missing_argument" | "wrong_argument_type";

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Parse and validate one tool call.
 *
 * A malformed call is a REJECTION, not a crash: the model gets a precise structured error
 * and may correct itself on its next turn, which is the whole reason the loop is bounded
 * rather than fatal. Nothing here touches a filesystem or trusts a value — a path is
 * carried through as the model wrote it and confined by the authority that resolves it.
 */
export function parseToolCall(call: BuilderToolCall): ParsedToolCall {
  if (!isBuilderToolName(call.name)) {
    return { ok: false, reason: "unknown_tool", detail: `"${call.name}" is not a tool you have; available: ${BUILDER_TOOL_NAMES.join(", ")}` };
  }

  let args: Record<string, unknown>;
  try {
    const raw = call.arguments.trim();
    const parsed: unknown = JSON.parse(raw.length === 0 ? "{}" : raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "malformed_arguments", detail: "arguments must be a JSON object" };
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: "malformed_arguments", detail: `arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (call.name === TOOL_FINISH_CANDIDATE) {
    const summary = asString(args["summary"]);
    if (summary === undefined) return { ok: false, reason: "missing_argument", detail: "finish_candidate requires a string `summary`" };
    if (typeof args["believesComplete"] !== "boolean") {
      return { ok: false, reason: "wrong_argument_type", detail: "finish_candidate requires a boolean `believesComplete`" };
    }
    return { ok: true, name: TOOL_FINISH_CANDIDATE, summary, believesComplete: args["believesComplete"] };
  }

  const path = asString(args["path"]);
  if (path === undefined || path.length === 0) return { ok: false, reason: "missing_argument", detail: `${call.name} requires a non-empty string \`path\`` };

  if (call.name === TOOL_READ_FILE) return { ok: true, name: TOOL_READ_FILE, path };

  const observationId = asString(args["observationId"]);
  if (observationId === undefined || observationId.length === 0) {
    // THE central refusal. There is no path-only variant of any write.
    return {
      ok: false,
      reason: "missing_argument",
      detail: `${call.name} requires the \`observationId\` from a read_file of "${path}" — every write must name the state it is replacing`,
    };
  }

  if (call.name === TOOL_DELETE_FILE) {
    return { ok: true, name: TOOL_DELETE_FILE, path, observationId: observationId as V2ObservationDigest };
  }

  const content = asString(args["content"]);
  if (content === undefined) return { ok: false, reason: "missing_argument", detail: `${call.name} requires a string \`content\`` };
  return { ok: true, name: call.name, path, observationId: observationId as V2ObservationDigest, content };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * What a tool did, as the model will be told.
 *
 * EVERY VARIANT STATES WHAT ACTUALLY HAPPENED. There is no shape in which a refused write
 * can be reported as applied: `refused` carries the state that was expected and the state
 * that is actually there, so the model can tell the difference between "someone else
 * changed it" and "I got the id wrong".
 */
export type ToolOutcome =
  | {
      readonly kind: "observed";
      readonly path: string;
      readonly observationId: string;
      readonly state: string;
      readonly contentSha256: string | null;
      readonly byteLength: number | null;
      /** Present for a regular file. Absent for missing/empty/directory/symlink. */
      readonly content?: string;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: "applied";
      readonly path: string;
      readonly operation: string;
      readonly mutationId: string;
      readonly changed: boolean;
      readonly beforeSha256: string | null;
      readonly afterSha256: string | null;
    }
  | {
      readonly kind: "refused";
      readonly path: string;
      readonly code: string;
      readonly detail: string;
      /** The state the named observation recorded, when the refusal is staleness. */
      readonly expectedSha256?: string | null;
      /** What is actually there now. */
      readonly actualSha256?: string | null;
    }
  | { readonly kind: "rejected"; readonly reason: ToolRejectionReason; readonly detail: string }
  | { readonly kind: "finished"; readonly summary: string; readonly believesComplete: boolean };

/** Did this outcome represent a tool that did NOT do what the model asked? */
export function isToolFailure(outcome: ToolOutcome): boolean {
  return outcome.kind === "refused" || outcome.kind === "rejected";
}

/** Max characters of file content handed back from one read. */
export const MAX_TOOL_READ_CHARS = 32_000;

/**
 * Render a tool outcome as the exact text the model receives.
 *
 * Plain labelled lines rather than JSON: the model has to reuse `observationId` verbatim
 * on its next call, and a value on its own line is markedly harder to mangle than one
 * nested in a structure it must re-serialize.
 */
export function renderToolOutcome(outcome: ToolOutcome): string {
  switch (outcome.kind) {
    case "observed": {
      const head = [
        `read_file: OBSERVED ${outcome.path}`,
        `state: ${outcome.state}`,
        `observationId: ${outcome.observationId}`,
        `sha256: ${outcome.contentSha256 ?? "(none)"}`,
        `bytes: ${outcome.byteLength ?? 0}`,
      ];
      if (outcome.content === undefined) {
        head.push(
          outcome.state === "missing"
            ? "There is nothing at this path. Use this observationId with create_file to create it."
            : "No file content is available for this kind of path.",
        );
        return head.join("\n");
      }
      if (outcome.truncated === true) head.push(`NOTE: content below is TRUNCATED to ${MAX_TOOL_READ_CHARS} characters; a replace_file would still need the COMPLETE file.`);
      head.push("--- content ---", outcome.content);
      return head.join("\n");
    }
    case "applied":
      return [
        `${outcome.operation}: APPLIED to ${outcome.path}`,
        `changed: ${String(outcome.changed)}`,
        `beforeSha256: ${outcome.beforeSha256 ?? "(none)"}`,
        `afterSha256: ${outcome.afterSha256 ?? "(none)"}`,
        `mutationId: ${outcome.mutationId}`,
        outcome.changed ? "" : "NOTE: the new content was byte-identical to the old, so nothing actually changed.",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    case "refused":
      return [
        `REFUSED: ${outcome.path} was NOT modified.`,
        `code: ${outcome.code}`,
        `detail: ${outcome.detail}`,
        ...(outcome.expectedSha256 !== undefined ? [`expected sha256: ${outcome.expectedSha256 ?? "(none)"}`] : []),
        ...(outcome.actualSha256 !== undefined ? [`actual sha256: ${outcome.actualSha256 ?? "(none)"}`] : []),
        "Nothing was written. Call read_file on this path to obtain a current observationId before trying again.",
      ].join("\n");
    case "rejected":
      return [`REJECTED: the call could not be used.`, `reason: ${outcome.reason}`, `detail: ${outcome.detail}`].join("\n");
    case "finished":
      return "finish_candidate: recorded. Stop now; do not call any further tools.";
  }
}
