/**
 * ikbi `spec` — create, list, and inspect spec artifacts (first-class editable plans).
 *
 * A spec is a goal decomposed into reviewable steps before any build runs. This command is the
 * operator's read/author surface over the spec store: `create` generates one from a goal with
 * sensible defaults (status `draft`, deterministic offline decomposition), `list` shows all
 * specs with human-readable status, and `status`/`show` render one spec's progress in plain
 * language rather than raw JSON.
 *
 *   ikbi spec create <goal...>   generate a draft spec from a goal
 *   ikbi spec list               list all specs (id, status, step count, goal)
 *   ikbi spec status <id>        show one spec's status + step progress
 *   ikbi spec show <id>          alias for `status`
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { whatNextFooter } from "./what-next.js";
import { listSpecs, getSpec, generateSpec, type SpecArtifact, type SpecStatus } from "../modules/spec-artifact/index.js";

const USAGE = "ikbi spec <create <goal...> | list | status <id> | show <id>>";

/** Plain-language gloss for each spec status (never expose only the internal token). */
const STATUS_LABEL: Readonly<Record<SpecStatus, string>> = {
  draft: "draft — editable; not yet approved",
  approved: "approved — ready to execute",
  executing: "executing — a build is in progress",
  completed: "completed — all steps done",
  failed: "failed — see the error below",
  not_implemented: "preview only — execution not yet wired",
};

function truncate(s: string, n = 72): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/** Render one spec's full status + step list in plain language. */
export function renderSpec(spec: SpecArtifact): string {
  const lines: string[] = [];
  lines.push(`Spec ${spec.id}`);
  lines.push(`  Goal:    ${truncate(spec.goal, 100)}`);
  lines.push(`  Status:  ${STATUS_LABEL[spec.status] ?? spec.status}`);
  lines.push(`  Steps:   ${spec.steps.length}`);
  for (const step of spec.steps) {
    const files = step.targetFiles !== undefined && step.targetFiles.length > 0 ? `  [${step.targetFiles.join(", ")}]` : "";
    lines.push(`    ${step.index}. ${truncate(step.goal, 80)}${files}`);
  }
  if (spec.output !== undefined && spec.output.length > 0) {
    lines.push("");
    lines.push("  Output:");
    for (const l of spec.output.split("\n")) lines.push(`    ${l}`);
  }
  if (spec.error !== undefined && spec.error.length > 0) {
    lines.push("");
    lines.push(`  Error:   ${spec.error}`);
  }
  return lines.join("\n");
}

export interface SpecCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Spec store surface (default: the live on-disk store). Injectable for tests. */
  readonly list?: () => SpecArtifact[];
  readonly get?: (id: string) => SpecArtifact | undefined;
  readonly create?: (goal: string) => SpecArtifact;
}

export function createSpecCli(deps: SpecCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const list = deps.list ?? (() => listSpecs());
  const get = deps.get ?? ((id: string) => getSpec(id));
  const create = deps.create ?? ((goal: string) => generateSpec(goal));

  function run(argv: readonly string[]): void {
    const sub = argv[0];
    if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
      out(`Usage: ${USAGE}\n\nCreate, list, and inspect spec artifacts (editable plans reviewed before a build).\n`);
      return;
    }

    if (sub === "list") {
      const specs = list();
      if (specs.length === 0) {
        out("No specs yet. Create one with `ikbi spec create \"<goal>\"`.\n");
        return;
      }
      out(`Specs (${specs.length}):\n`);
      for (const s of specs) {
        out(`  • ${s.id}  [${s.status}]  ${s.steps.length} step(s) — ${truncate(s.goal)}\n`);
      }
      out(`${whatNextFooter("spec")}\n`);
      return;
    }

    if (sub === "status" || sub === "show") {
      const id = argv[1];
      if (id === undefined) {
        err(`usage: ikbi spec ${sub} <id>\n`);
        setExit(1);
        return;
      }
      const spec = get(id);
      if (spec === undefined) {
        err(`spec: no spec "${id}" (run \`ikbi spec list\`)\n`);
        setExit(1);
        return;
      }
      out(`${renderSpec(spec)}\n`);
      return;
    }

    if (sub === "create") {
      const goal = argv.slice(1).join(" ").trim();
      if (goal.length === 0) {
        err("usage: ikbi spec create <goal...>\n");
        setExit(1);
        return;
      }
      let spec: SpecArtifact;
      try {
        spec = create(goal);
      } catch (e) {
        err(`spec: could not create spec: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
        return;
      }
      out(`Created spec ${spec.id} — ${spec.steps.length} step(s), status: ${spec.status}.\n`);
      out(`${renderSpec(spec)}\n`);
      out(`${whatNextFooter("spec")}\n`);
      return;
    }

    err(`spec: unknown subcommand "${sub}" — ${USAGE}\n`);
    setExit(1);
  }

  return { run };
}

registerCommand({
  name: "spec",
  summary: "Create, list, and inspect spec artifacts (editable plans reviewed before a build)",
  usage: USAGE,
  category: "advanced",
  run: (argv) => createSpecCli().run(argv),
});
