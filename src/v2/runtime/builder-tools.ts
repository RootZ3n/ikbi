/**
 * THE BUILDER TOOL EXECUTOR — the only thing that can change a candidate file.
 *
 * It holds the capability the builder controller deliberately does not: the workspace
 * record and the state-bound mutation authority. The controller can only ask; this decides
 * what that means and reports back exactly what happened.
 *
 * WHAT THE MODEL NEVER RECEIVES, and cannot obtain through any tool result: the
 * workspace's absolute path, a filesystem handle, the mutation core, the workspace
 * manager, or a credential. It gets paths it already named, content it asked to read, and
 * opaque ids. `observationId` is the entire vocabulary of capability it holds, and an id
 * is not a capability it can forge — the authority keeps its own table of what it saw.
 *
 * IT PERFORMS NO WRITE ITSELF. There is no `node:fs` import here and no way to add one
 * without failing the guard in `core/isolation.test.ts`: every effect goes through
 * `StateBoundMutationAuthority.mutate`, which re-reads the path under a lock and refuses
 * when the bytes moved.
 *
 * REFUSALS ARE REPORTED, NEVER REPAIRED. A stale write comes back as `refused` with the
 * state that was expected and the state that is actually there. The executor does not
 * re-observe and retry — that decision belongs to the model, on its next turn, and taking
 * it here would silently defeat the compare-and-swap.
 */

import { MAX_TOOL_READ_CHARS, TOOL_CREATE_FILE, TOOL_DELETE_FILE, TOOL_READ_FILE, TOOL_REPLACE_FILE, type ToolOutcome } from "../core/tools.js";
import type { BuilderToolExecutor, BuilderToolExecutorDeps, ToolExecution } from "../core/builder.js";
import type { V2FileObservation, MutationOperation } from "../core/workspace.js";
import type { V2ObservationDigest } from "../core/identity.js";
import type { RunFailure } from "../core/failure.js";

/**
 * Observations this executor has handed out, by id.
 *
 * The model quotes an id back; the executor looks up the observation it actually issued.
 * A model cannot construct an entry here, so an invented or guessed id resolves to
 * nothing and is refused before any authority is touched.
 */
type ObservationTable = Map<string, V2FileObservation>;

/** Turn a v2 run failure into the refusal the model will read. */
function refusal(path: string, failure: RunFailure): ToolOutcome {
  return { kind: "refused", path, code: failure.code, detail: failure.message };
}

/** Build the executor for ONE workspace. It cannot reach any other. */
export function createBuilderToolExecutor(deps: BuilderToolExecutorDeps): BuilderToolExecutor {
  const issued: ObservationTable = new Map();
  const { runId, workspace, mutations } = deps;

  /** Resolve an id the model quoted back, or explain why it is not usable. */
  function resolve(observationId: V2ObservationDigest, path: string): V2FileObservation | ToolOutcome {
    const observation = issued.get(observationId);
    if (observation === undefined) {
      return {
        kind: "refused",
        path,
        code: "mutation.unknown_observation",
        detail: `observationId "${observationId}" was never issued in this workspace — call read_file(${path}) to obtain one`,
      };
    }
    if (observation.path !== path) {
      // A real class of model error: quoting the id from a DIFFERENT file's read. The
      // observation authorizes that file's state, not this one's.
      return {
        kind: "refused",
        path,
        code: "mutation.observation_path_mismatch",
        detail: `that observationId belongs to "${observation.path}", not "${path}"`,
      };
    }
    return observation;
  }

  const isOutcome = (value: V2FileObservation | ToolOutcome): value is ToolOutcome => "kind" in value;

  async function applyMutation(
    path: string,
    observationId: V2ObservationDigest,
    operation: MutationOperation,
    label: string,
  ): Promise<ToolExecution> {
    const resolved = resolve(observationId, path);
    if (isOutcome(resolved)) return { outcome: resolved };

    const applied = await mutations.mutate({ runId, workspace, observation: resolved, operation });
    if (!applied.ok) {
      // Staleness is the interesting one: the detail already names both states, and the
      // observed state we hold is what the model was told when it read.
      const actual = typeof applied.failure.detail?.["actualSha256"] === "string" ? String(applied.failure.detail["actualSha256"]) : undefined;
      return {
        outcome: {
          kind: "refused",
          path,
          code: applied.failure.code,
          detail: applied.failure.message,
          expectedSha256: resolved.state.contentSha256,
          ...(actual !== undefined ? { actualSha256: actual } : {}),
        },
      };
    }

    const record = applied.record;
    deps.onMutation({ mutationId: record.mutationId, path: record.path, observationId: record.observationId });
    return {
      outcome: {
        kind: "applied",
        path: record.path,
        operation: label,
        mutationId: record.mutationId,
        changed: record.changed,
        beforeSha256: record.before.contentSha256,
        afterSha256: record.after.contentSha256,
      },
      mutation: { mutationId: record.mutationId, path: record.path },
    };
  }

  return {
    async execute(call): Promise<ToolExecution> {
      switch (call.name) {
        case TOOL_READ_FILE: {
          // EVERY READ IS AN OBSERVATION. There is no other file-reading capability in
          // the builder path, so "the model looked" and "an observation exists" are the
          // same event by construction.
          const read = await mutations.read({ runId, workspace, path: call.path, maxChars: MAX_TOOL_READ_CHARS });
          if (!read.ok) return { outcome: refusal(call.path, read.failure) };

          const observation = read.observation;
          issued.set(observation.observationId, observation);
          deps.onObservation(observation);

          const whole = observation.state.byteLength ?? 0;
          return {
            outcome: {
              kind: "observed",
              path: observation.path,
              observationId: observation.observationId,
              state: observation.state.kind,
              contentSha256: observation.state.contentSha256,
              byteLength: observation.state.byteLength,
              ...(read.content !== undefined ? { content: read.content } : {}),
              ...(read.content !== undefined && whole > read.content.length ? { truncated: true } : {}),
            },
          };
        }

        case TOOL_REPLACE_FILE:
          return applyMutation(call.path, call.observationId, { kind: "replace", content: Buffer.from(call.content, "utf8") }, "replace_file");

        case TOOL_CREATE_FILE:
          return applyMutation(call.path, call.observationId, { kind: "create", content: Buffer.from(call.content, "utf8") }, "create_file");

        case TOOL_DELETE_FILE:
          return applyMutation(call.path, call.observationId, { kind: "delete" }, "delete_file");

        default:
          // `finish_candidate` is interpreted by the controller and never reaches here;
          // any other name was already rejected by the parser.
          return { outcome: { kind: "rejected", reason: "unknown_tool", detail: `${String(call.name)} is not executable here` } };
      }
    },
  };
}
