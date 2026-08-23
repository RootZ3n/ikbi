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

import { MAX_TOOL_READ_CHARS, TOOL_CREATE_FILE, TOOL_DELETE_FILE, TOOL_READ_FILE, TOOL_REPLACE_FILE, TOOL_RUN_COMMAND, TOOL_RUN_FORMATTER, type ToolOutcome } from "../core/tools.js";
import { FORMATTER_IDS, isFormatterId } from "../core/formatter.js";
import { decideMutation, describeScope, type MutationOperationKind } from "../core/mutation-scope.js";
import type { BuilderToolExecutor, BuilderToolExecutorDeps, ToolExecution } from "../core/builder.js";
import { commandRefusalOutcome } from "../core/command.js";
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
  // A per-candidate command ordinal, so each command event has a distinct, order-preserving id.
  let commandOrdinal = 0;
  // A per-candidate formatter ordinal, so each invocation has a distinct, ordered identity.
  let formatterOrdinal = 0;

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
    scopedOperation: MutationOperationKind,
  ): Promise<ToolExecution> {
    const resolved = resolve(observationId, path);
    if (isOutcome(resolved)) return { outcome: resolved };

    /*
      THE SCOPE GATE — before the authority is touched, and per OPERATION.

      Checked here rather than only at publication because a refusal the model can still act
      on is worth far more than a rejection after the work is done: it gets told which path it
      may not touch, on the turn it tried, and can choose differently. Publication re-checks
      the final tree anyway; that one is the assertion that THIS gate held, not a substitute
      for it.

      `create`, `modify` and `delete` are decided separately. They are different effects on the
      operator's repository, and a refusal that could not say which one it refused would be a
      worse account of what happened.
    */
    const decision = decideMutation(deps.mutationScope, { path, operation: scopedOperation });
    if (!decision.allowed) {
      return {
        outcome: {
          kind: "refused",
          path,
          code: `mutation.${decision.code}`,
          detail:
            `${decision.detail}. This build may change: ${describeScope(deps.mutationScope)}. ` +
            `The scope is the operator's and cannot be widened from here — work within it, or finish and explain what is missing.`,
        },
      };
    }

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
          return applyMutation(call.path, call.observationId, { kind: "replace", content: Buffer.from(call.content, "utf8") }, "replace_file", "modify");

        case TOOL_CREATE_FILE:
          return applyMutation(call.path, call.observationId, { kind: "create", content: Buffer.from(call.content, "utf8") }, "create_file", "create");

        case TOOL_DELETE_FILE:
          return applyMutation(call.path, call.observationId, { kind: "delete" }, "delete_file", "delete");

        case TOOL_RUN_COMMAND: {
          // A READ-ONLY command — it CANNOT mutate and mints NO observation. When no command
          // capability is wired, the terminal is truthfully unavailable rather than silently absent.
          if (deps.commands === undefined) {
            return { outcome: commandRefusalOutcome({ program: call.program, args: call.args, cwd: call.cwd, code: "terminal_unavailable", detail: "the read-only command terminal is not available in this build" }) };
          }
          commandOrdinal += 1;
          const result = await deps.commands.run({ runId, workspacePath: workspace.path, ordinal: commandOrdinal, program: call.program, args: call.args, cwd: call.cwd });
          return {
            outcome: result.outcome,
            ...(result.command !== undefined ? { command: result.command } : {}),
            ...(result.safetyFailure !== undefined ? { safetyFailure: result.safetyFailure } : {}),
          };
        }

        case TOOL_RUN_FORMATTER: {
          if (deps.formatter === undefined) {
            return {
              outcome: {
                kind: "formatted", formatterId: call.formatter, outcome: "refused_unavailable",
                changedPaths: [], refusedPaths: [], timedOut: false,
                untrusted: "no formatter capability is wired into this build",
              },
            };
          }
          // The identifier is validated against the CLOSED set before anything else. An unknown
          // name is refused here — the capability is never asked to interpret model text.
          if (!isFormatterId(call.formatter)) {
            const applicable = await deps.formatter.available(workspace.path);
            return {
              outcome: {
                kind: "formatted", formatterId: call.formatter, outcome: "refused_unavailable",
                changedPaths: [], refusedPaths: [], timedOut: false,
                untrusted:
                  `"${call.formatter}" is not a formatter. Known formatters: ${FORMATTER_IDS.join(", ")}. ` +
                  `Applicable to this repository: ${applicable.length > 0 ? applicable.join(", ") : "(none)"}.`,
              },
            };
          }
          const applicable = await deps.formatter.available(workspace.path);
          if (!applicable.includes(call.formatter)) {
            return {
              outcome: {
                kind: "formatted", formatterId: call.formatter, outcome: "refused_unavailable",
                changedPaths: [], refusedPaths: [], timedOut: false,
                untrusted: `"${call.formatter}" does not apply to this repository (its marker files are absent). Nothing ran.`,
              },
            };
          }
          formatterOrdinal += 1;
          const result = await deps.formatter.run({
            runId,
            ordinal: formatterOrdinal,
            formatterId: call.formatter,
            workspaceId: workspace.workspaceId,
            workspacePath: workspace.path,
            baseCommit: workspace.source.baseCommit,
          });
          // A formatter that APPLIED wrote through the mutation authority, so every observation the
          // model holds for a changed path is now stale. Nothing here re-observes on its behalf —
          // that is its decision, exactly as it is after any refused compare-and-swap.
          if (result.record !== undefined) deps.onFormatter?.(result.record);
          return {
            outcome: result.outcome,
            ...(result.safetyFailure !== undefined ? { safetyFailure: result.safetyFailure } : {}),
          };
        }

        default:
          // `finish_candidate` is interpreted by the controller and never reaches here;
          // any other name was already rejected by the parser.
          return { outcome: { kind: "rejected", reason: "unknown_tool", detail: `${String(call.name)} is not executable here` } };
      }
    },
  };
}
