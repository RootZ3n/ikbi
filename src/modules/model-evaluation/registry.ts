/**
 * ikbi model-evaluation — BENCHMARK REGISTRY (the executable benchmark definitions).
 *
 * The canonical list of build/repair benchmarks a model is scored against: each carries
 * its prompt-quality level, the capabilities it exercises, the max files a correct
 * solution changes, the expected pipeline phases, and the success/failure criteria the
 * deterministic verifiers enforce. This is DATA — no behavior — so the routing harness
 * and the summary can describe a benchmark without running it.
 *
 * Ported verbatim from scintilla/src/core/benchmark/registry.ts. Standalone.
 */

export type PromptQualityLevel = "P0" | "P1" | "P2" | "P3" | "P4";

export type PipelinePhase =
  | "scope_intake"
  | "context_retrieval"
  | "plan"
  | "decompose"
  | "edit"
  | "verify"
  | "report";

export type ModelTier = "small" | "medium" | "large";

export interface BenchmarkDefinition {
  id: string;
  title: string;
  description: string;
  baseline: boolean;
  prompt_quality_level: PromptQualityLevel;
  required_capabilities: readonly string[];
  max_files_changed: number;
  expected_pipeline_phases: readonly PipelinePhase[];
  success_criteria: readonly string[];
  failure_criteria: readonly string[];
  recommended_model_tiers: readonly ModelTier[];
  verifier_requirements: readonly string[];
}

export const benchmarkRegistry = [
  {
    id: "docs_single_file_edit",
    title: "Docs single-file edit",
    description:
      "Apply a clear, bounded documentation update in one named Markdown file without touching unrelated files.",
    baseline: true,
    prompt_quality_level: "P0",
    required_capabilities: ["scope control", "markdown editing", "verification reporting"],
    max_files_changed: 1,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "edit", "verify", "report"],
    success_criteria: [
      "Exactly one documentation file is changed and the requested content is present.",
      "Final report includes verification evidence from a relevant diff, test, lint, or explicit file inspection."
    ],
    failure_criteria: [
      "Changes files outside the requested documentation target.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["small", "medium", "large"],
    verifier_requirements: ["Inspect git diff for file count and content.", "Require evidence beyond model self-claim."]
  },
  {
    id: "config_single_file_edit",
    title: "Config single-file edit",
    description:
      "Make a precise configuration change in one known config file while preserving existing structure and formatting.",
    baseline: true,
    prompt_quality_level: "P0",
    required_capabilities: ["config editing", "schema awareness", "scope control", "verification reporting"],
    max_files_changed: 1,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "edit", "verify", "report"],
    success_criteria: [
      "Exactly one config file is changed and the requested setting is represented correctly.",
      "Final report includes verification evidence from parsing, typecheck, tests, or direct file inspection."
    ],
    failure_criteria: [
      "Introduces invalid config syntax or changes unrelated settings.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["small", "medium", "large"],
    verifier_requirements: ["Parse or typecheck the edited config when possible.", "Require evidence beyond model self-claim."]
  },
  {
    id: "failing_test_single_file_fix",
    title: "Failing test single-file fix",
    description:
      "Resolve a localized failing test by changing one implementation file, keeping the observed failure as the guide.",
    baseline: true,
    prompt_quality_level: "P0",
    required_capabilities: ["test failure analysis", "single-file code edit", "regression verification"],
    max_files_changed: 1,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "plan", "edit", "verify", "report"],
    success_criteria: [
      "The targeted failing test passes after one implementation file is changed.",
      "Final report includes verification evidence from the failing test rerun or equivalent test command."
    ],
    failure_criteria: [
      "Deletes or weakens the failing test instead of fixing implementation behavior.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["small", "medium", "large"],
    verifier_requirements: ["Capture before/after test command evidence when feasible.", "Require evidence beyond model self-claim."]
  },
  {
    id: "three_file_chain_config_test_docs",
    title: "Three-file config-test-docs chain",
    description:
      "Make a linked config, test, and documentation update through explicit single-file, single-purpose steps.",
    baseline: true,
    prompt_quality_level: "P0",
    required_capabilities: [
      "single-file/single-purpose step decomposition",
      "config editing",
      "test editing",
      "documentation editing",
      "regression verification"
    ],
    max_files_changed: 3,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "plan", "decompose", "edit", "verify", "report"],
    success_criteria: [
      "Exactly three files are changed: one config file, one test file, and one documentation file.",
      "Work is decomposed into explicit single-file, single-purpose steps before or during execution.",
      "Final report includes verification evidence from tests plus diff or file inspection."
    ],
    failure_criteria: [
      "Combines unrelated edits into one broad change or changes more than three files.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["medium", "large"],
    verifier_requirements: [
      "Inspect changed file list and confirm the config/test/docs split.",
      "Confirm decomposition evidence is present.",
      "Require evidence beyond model self-claim."
    ]
  },
  {
    id: "context_retrieval_only",
    title: "Context retrieval only",
    description:
      "Answer a repository question by finding and citing the relevant local context without editing files.",
    baseline: true,
    prompt_quality_level: "P0",
    required_capabilities: ["repository search", "source citation", "no-edit scope control"],
    max_files_changed: 0,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "verify", "report"],
    success_criteria: [
      "No files are changed and the answer cites the relevant repository files or command output.",
      "Final report includes verification evidence from search results, file reads, or command output."
    ],
    failure_criteria: [
      "Edits files or answers without grounding in retrieved repository context.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["small", "medium", "large"],
    verifier_requirements: ["Check git diff is empty.", "Require cited retrieval evidence beyond model self-claim."]
  },
  {
    id: "drift_detection",
    title: "Drift detection",
    description:
      "Detect when current repository behavior or documentation has drifted from a stated expectation before proposing action.",
    baseline: false,
    prompt_quality_level: "P2",
    required_capabilities: ["expectation comparison", "evidence collection", "risk reporting"],
    max_files_changed: 0,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "verify", "report"],
    success_criteria: [
      "Identifies whether drift exists and names the exact evidence used to reach that conclusion.",
      "Final report includes verification evidence from file inspection, commands, or tests."
    ],
    failure_criteria: [
      "Assumes drift exists or does not exist without checking current repository state.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["medium", "large"],
    verifier_requirements: ["Compare expected and observed facts.", "Require evidence beyond model self-claim."]
  },
  {
    id: "scope_violation_detection",
    title: "Scope violation detection",
    description:
      "Recognize requested or produced changes that exceed the stated task boundary and report the violation without broadening scope.",
    baseline: false,
    prompt_quality_level: "P2",
    required_capabilities: ["scope analysis", "diff inspection", "boundary enforcement"],
    max_files_changed: 0,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "verify", "report"],
    success_criteria: [
      "Flags out-of-scope files, behaviors, or instructions using concrete evidence.",
      "Final report includes verification evidence from changed-file inspection, prompt comparison, or command output."
    ],
    failure_criteria: [
      "Accepts unrelated changes as successful or expands the task without explicit approval.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["medium", "large"],
    verifier_requirements: ["Inspect the prompt boundary and changed-file list.", "Require evidence beyond model self-claim."]
  },
  {
    id: "messy_prompt_resilience",
    title: "Messy prompt resilience",
    description:
      "Extract the actionable task from noisy, contradictory, or low-quality instructions while preserving explicit constraints.",
    baseline: false,
    prompt_quality_level: "P3",
    required_capabilities: ["prompt triage", "constraint extraction", "scope control", "verification planning"],
    max_files_changed: 0,
    expected_pipeline_phases: ["scope_intake", "context_retrieval", "plan", "decompose", "verify", "report"],
    success_criteria: [
      "Extracts a concrete scoped task from noisy instructions without editing files.",
      "Interpreted task includes verification evidence requirements from tests, typecheck, or equivalent checks."
    ],
    failure_criteria: [
      "Accepts vague prompt wording as permission for broad edits, unrelated refactors, or completed work claims.",
      "Reports success based on model self-claim without verifier evidence."
    ],
    recommended_model_tiers: ["medium", "large"],
    verifier_requirements: [
      "Review extracted constraints against the original prompt.",
      "Confirm no files are changed.",
      "Require evidence beyond model self-claim."
    ]
  }
] as const satisfies readonly BenchmarkDefinition[];

export type BenchmarkId = (typeof benchmarkRegistry)[number]["id"];

export function getBenchmarkById(id: BenchmarkId): BenchmarkDefinition {
  return benchmarkRegistry.find((benchmark) => benchmark.id === id) as BenchmarkDefinition;
}
