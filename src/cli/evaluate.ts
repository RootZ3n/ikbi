/**
 * ikbi `evaluate` — run the model CAPABILITY HARNESS against one or more models.
 *
 * This is the comparison surface for ikbi's whole pitch: "prove a cheap model is good enough to
 * replace Claude Code at this task." The capability-harness (`worker-model/capability-harness.ts`)
 * evaluates each model across four modes (agent / patch / plan_patch / repair) against in-memory
 * fixtures with ground-truth oracles, and emits a scorecard + a routing recommendation
 * (agent_builder / patch_builder / repair_builder / critic_only / not_recommended). This command
 * runs that harness for every requested model and prints a side-by-side comparison.
 *
 *   ikbi evaluate                                        # default fixtures, the configured builder
 *   ikbi evaluate --models a,b --modes agent,patch       # compare two models, show two modes
 *   ikbi evaluate --fixture .ikbi/fixtures/auth.json     # a custom fixture set
 *   ikbi evaluate --json                                 # machine-readable scorecards (for CI)
 *   ikbi evaluate --write-providers                      # persist the routing to ~/.ikbi/providers.json
 *
 * FIXTURE FORMAT (serializable): the harness's oracles are FUNCTIONS, which JSON can't carry, so a
 * fixture file declares its oracles as regex specs (`mustMatch` / `mustNotMatch` against a file) and
 * this loader compiles them into the harness's `targetTestPasses` / `fullVerificationPasses`.
 *
 * READ-ONLY to the repo. The harness itself is side-effect-free (in-memory file maps); the only
 * write this command can make is the opt-in `--write-providers` routing file.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { whatNextFooter } from "./what-next.js";
import { config } from "../core/config.js";
import {
  runCapabilityHarness,
  DEFAULT_FIXTURES,
  type CapabilityMode,
  type CapabilityScorecard,
  type HarnessFixture,
} from "../modules/worker-model/capability-harness.js";
import type { RoleEngine } from "../modules/worker-model/contract.js";

const ALL_MODES: readonly CapabilityMode[] = ["agent", "patch", "plan_patch", "repair"];

const USAGE =
  "ikbi evaluate [--models <a,b,...>] [--modes <agent,patch,plan_patch,repair>] [--fixture <path>] [--repo <dir>] [--max-extra-files <n>] [--json] [--write-providers]";

// ── Serializable fixture format ────────────────────────────────────────────────

/** An oracle expressed as regex assertions over one file's post-patch content. */
interface OracleSpec {
  readonly file: string;
  readonly mustMatch?: readonly string[];
  readonly mustNotMatch?: readonly string[];
}

/** The on-disk fixture shape (`*.json`). Oracles are regex specs, compiled below. */
export interface FixtureJson {
  readonly name: string;
  readonly goal: string;
  readonly files: Readonly<Record<string, string>>;
  readonly targetFile: string;
  readonly forbiddenFiles?: readonly string[];
  readonly repairVerifierOutput: string;
  readonly oracle: { readonly targetTest: OracleSpec; readonly fullVerification: OracleSpec };
}

/** Compile an OracleSpec into the harness's boolean oracle over a post-patch file map. */
function compileOracle(spec: OracleSpec): (files: Readonly<Record<string, string>>) => boolean {
  const must = (spec.mustMatch ?? []).map((p) => new RegExp(p));
  const mustNot = (spec.mustNotMatch ?? []).map((p) => new RegExp(p));
  return (files) => {
    const content = files[spec.file] ?? "";
    return must.every((re) => re.test(content)) && mustNot.every((re) => !re.test(content));
  };
}

/** Validate + compile one on-disk fixture into a HarnessFixture. Throws on a malformed shape. */
export function compileFixture(json: unknown): HarnessFixture {
  const f = json as FixtureJson;
  const where = (typeof f?.name === "string" ? `fixture "${f.name}"` : "fixture");
  if (typeof f?.name !== "string" || f.name.length === 0) throw new Error(`${where}: missing "name"`);
  if (typeof f.goal !== "string" || f.goal.length === 0) throw new Error(`${where}: missing "goal"`);
  if (typeof f.files !== "object" || f.files === null) throw new Error(`${where}: missing "files" map`);
  if (typeof f.targetFile !== "string") throw new Error(`${where}: missing "targetFile"`);
  if (typeof f.repairVerifierOutput !== "string") throw new Error(`${where}: missing "repairVerifierOutput"`);
  if (typeof f.oracle?.targetTest?.file !== "string" || typeof f.oracle?.fullVerification?.file !== "string") {
    throw new Error(`${where}: oracle.targetTest.file and oracle.fullVerification.file are required`);
  }
  return {
    name: f.name,
    goal: f.goal,
    files: f.files,
    targetFile: f.targetFile,
    ...(f.forbiddenFiles !== undefined ? { forbiddenFiles: f.forbiddenFiles } : {}),
    repairVerifierOutput: f.repairVerifierOutput,
    targetTestPasses: compileOracle(f.oracle.targetTest),
    fullVerificationPasses: compileOracle(f.oracle.fullVerification),
  };
}

/** Read a fixture file that holds either one fixture object or an array of them. */
function readFixtureFile(path: string): HarnessFixture[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(compileFixture);
}

// ── Arg parsing ────────────────────────────────────────────────────────────────

export interface EvaluateArgs {
  readonly repo: string;
  readonly models: string[];
  readonly modes: CapabilityMode[];
  readonly fixture?: string;
  readonly maxExtraFiles: number;
  readonly json: boolean;
  readonly writeProviders: boolean;
  readonly help: boolean;
}

function parseModes(raw: string | undefined): CapabilityMode[] {
  if (raw === undefined) return [...ALL_MODES];
  const requested = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const valid = requested.filter((m): m is CapabilityMode => (ALL_MODES as readonly string[]).includes(m));
  return valid.length > 0 ? valid : [...ALL_MODES];
}

export function parseEvaluateArgs(argv: readonly string[], defaultModel: string): EvaluateArgs {
  let repo = process.cwd();
  let modelsRaw: string | undefined;
  let modesRaw: string | undefined;
  let fixture: string | undefined;
  let maxExtraFiles = 0;
  let json = false;
  let writeProviders = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--json") json = true;
    else if (a === "--write-providers") writeProviders = true;
    else if (a === "--models") { if (argv[i + 1] !== undefined) modelsRaw = argv[i + 1]; i += 1; }
    else if (a === "--modes") { if (argv[i + 1] !== undefined) modesRaw = argv[i + 1]; i += 1; }
    else if (a === "--fixture") { if (argv[i + 1] !== undefined) fixture = argv[i + 1]; i += 1; }
    else if (a === "--repo") { if (argv[i + 1] !== undefined) repo = argv[i + 1] as string; i += 1; }
    else if (a === "--max-extra-files") { const n = Number(argv[i + 1]); if (Number.isInteger(n) && n >= 0) maxExtraFiles = n; i += 1; }
  }
  const models = (modelsRaw ?? defaultModel).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    repo,
    models,
    modes: parseModes(modesRaw),
    ...(fixture !== undefined ? { fixture } : {}),
    maxExtraFiles,
    json,
    writeProviders,
    help,
  };
}

/** Resolve the fixtures for a run: explicit `--fixture`, then `.ikbi/fixtures/*.json`, then defaults. */
export function loadFixtures(args: EvaluateArgs): { fixtures: HarnessFixture[]; source: string } {
  if (args.fixture !== undefined) {
    const path = isAbsolute(args.fixture) ? args.fixture : join(args.repo, args.fixture);
    return { fixtures: readFixtureFile(path), source: path };
  }
  const dir = join(args.repo, ".ikbi", "fixtures");
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    const fixtures = files.flatMap((f) => readFixtureFile(join(dir, f)));
    if (fixtures.length > 0) return { fixtures, source: dir };
  }
  return { fixtures: [...DEFAULT_FIXTURES], source: "built-in defaults" };
}

// ── Output ──────────────────────────────────────────────────────────────────────

/** Format a [0,1] fraction as a 2dp string. */
function pct(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Render the comparison as a Markdown table + per-model routing reasons. */
export function formatMarkdown(cards: readonly CapabilityScorecard[], fixtureCount: number, source: string, modes: readonly CapabilityMode[]): string {
  const lines: string[] = [];
  lines.push("# ikbi evaluate — capability scorecard\n");
  lines.push(`Fixtures: ${fixtureCount} (source: ${source})`);
  lines.push(`Modes: ${modes.join(", ")}\n`);
  lines.push("| Model | tool_call | schema | patch_parse | diff_min | target_test | full_verify | repair | overclaim | → recommended |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cards) {
    lines.push(
      `| ${c.model} | ${pct(c.tool_call_reliability)} | ${pct(c.schema_reliability)} | ${pct(c.patch_parseability)} | ${pct(c.diff_minimality)} | ${pct(c.target_test_pass)} | ${pct(c.full_verification_pass)} | ${pct(c.repair_success_rate)} | ${pct(c.overclaiming_rate)} | **${c.recommended_role}** |`,
    );
  }
  lines.push("");
  lines.push("## Routing");
  for (const c of cards) lines.push(`- **${c.model}** → ${c.recommended_role}: ${c.routing_reason}`);
  lines.push("");
  return lines.join("\n");
}

/** Keep only the observations for the requested modes (the routing card always uses the full run). */
function filterObservations(card: CapabilityScorecard, modes: readonly CapabilityMode[]): CapabilityScorecard {
  if (modes.length === ALL_MODES.length) return card;
  return { ...card, observations: card.observations.filter((o) => modes.includes(o.mode)) };
}

// ── Routing persistence (--write-providers) ──────────────────────────────────────

/** Default routing-file path. */
export function defaultProvidersPath(): string {
  return join(homedir(), ".ikbi", "providers.json");
}

/**
 * Merge `{ routing: { <model>: <role> } }` into the providers file, non-destructively: read the
 * existing JSON object (or start from {}), update only the `routing` map, and atomically write back.
 */
export function writeRoutingToProviders(path: string, cards: readonly CapabilityScorecard[]): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      /* unreadable/corrupt — start fresh rather than crash */
    }
  }
  const routing: Record<string, string> = { ...(existing.routing as Record<string, string> | undefined) };
  for (const c of cards) routing[c.model] = c.recommended_role;
  const next = { ...existing, routing };
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export interface EvaluateCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Run the harness for one model (default: the real harness on a provider-backed engine). */
  readonly runHarness?: (model: string, fixtures: readonly HarnessFixture[], maxExtraFiles: number) => Promise<CapabilityScorecard>;
  /** Persist routing (default: merge into ~/.ikbi/providers.json). */
  readonly writeRouting?: (cards: readonly CapabilityScorecard[]) => string;
  /** Default model when --models is omitted (default: the configured builder). */
  readonly defaultModel?: string;
}

/**
 * Build a provider-backed RoleEngine. The harness fully forms each request; we just forward it.
 * The provider singleton + injection floor are imported LAZILY here (not at module top level): the
 * provider registry constructs at import time and requires the egress fetch guard to be registered
 * first (the modules barrel does that). Loading them only when a real run starts keeps `ikbi
 * evaluate --help` and the unit tests (which inject `runHarness`) free of that ordering constraint.
 */
async function providerEngine(): Promise<RoleEngine> {
  const { invokeModel } = await import("../core/provider/index.js");
  const { neutralizeUntrusted } = await import("../core/injection/index.js");
  return { invokeModel, neutralizeUntrusted };
}

export function createEvaluateCli(deps: EvaluateCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const defaultModel = deps.defaultModel ?? config.provider.defaultModels.builder;
  const runHarness =
    deps.runHarness ??
    (async (model: string, fixtures: readonly HarnessFixture[], maxExtraFiles: number) =>
      runCapabilityHarness({ model, engine: await providerEngine(), fixtures, maxExtraFiles }));
  const writeRouting =
    deps.writeRouting ??
    ((cards: readonly CapabilityScorecard[]) => {
      const path = defaultProvidersPath();
      writeRoutingToProviders(path, cards);
      return path;
    });

  async function run(argv: readonly string[]): Promise<void> {
    const args = parseEvaluateArgs(argv, defaultModel);
    if (args.help) {
      out(`Usage: ${USAGE}\n\nEvaluate model capability across four modes against fixtures; emit a side-by-side scorecard + routing.\n`);
      return;
    }
    if (args.models.length === 0) {
      err("evaluate: no models to evaluate — pass --models <a,b,...> or set IKBI_MODEL_BUILDER\n");
      setExit(1);
      return;
    }

    let fixtures: HarnessFixture[];
    let source: string;
    try {
      ({ fixtures, source } = loadFixtures(args));
    } catch (e) {
      err(`evaluate: could not load fixtures: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (fixtures.length === 0) {
      err("evaluate: no fixtures to run\n");
      setExit(1);
      return;
    }

    const cards: CapabilityScorecard[] = [];
    for (const model of args.models) {
      try {
        const card = await runHarness(model, fixtures, args.maxExtraFiles);
        cards.push(filterObservations(card, args.modes));
      } catch (e) {
        err(`evaluate: harness failed for "${model}": ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
        return;
      }
    }

    if (args.json) {
      out(`${JSON.stringify({ fixtures: fixtures.length, source, modes: args.modes, scorecards: cards }, null, 2)}\n`);
    } else {
      out(`${formatMarkdown(cards, fixtures.length, source, args.modes)}\n`);
    }

    if (args.writeProviders) {
      try {
        const path = writeRouting(cards);
        if (!args.json) out(`Routing written to ${path}\n`);
      } catch (e) {
        err(`evaluate: could not write routing: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
      }
    }

    // "What next": point the operator at applying the routing. The winner is the first model
    // whose harness recommends it for a real builder/critic role (not "not_recommended").
    if (!args.json) {
      const winner = cards.find((c) => c.recommended_role !== "not_recommended")?.model;
      out(`${whatNextFooter("evaluate", winner !== undefined ? { winner } : {})}\n`);
    }
  }

  return { run };
}

registerCommand({
  name: "evaluate",
  summary: "Run the capability harness across models; side-by-side scorecard + routing (markdown or --json)",
  usage: USAGE,
  run: (argv) => createEvaluateCli().run(argv),
});
