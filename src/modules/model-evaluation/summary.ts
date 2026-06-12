/**
 * ikbi model-evaluation — EXECUTABLE BENCHMARK SUMMARY.
 *
 * Describes each executable benchmark WITHOUT running it: the allowed changed files, the
 * required/optional candidate fields a verifier expects, what it verifies, and what it
 * rejects. The capability harness and CLI use this to tell an operator what a model will
 * be scored on before a single candidate is produced. Pure data derivation over the
 * registry + fixture metadata.
 *
 * Ported verbatim from scintilla/src/core/benchmark/summary.ts. Standalone.
 */

import { benchmarkFixtures } from "./fixtures.js";
import { benchmarkRegistry, type BenchmarkDefinition, type PromptQualityLevel } from "./registry.js";

export interface ExecutableBenchmarkSummary {
  readonly benchmarkId: string;
  readonly title: string;
  readonly promptQualityLevel: PromptQualityLevel;
  readonly isBaseline: boolean;
  readonly hasExecutableFixture: boolean;
  readonly fixtureId: string;
  readonly verifierId: string;
  readonly allowedChangedFiles: readonly string[];
  readonly requiresZeroEdits: boolean;
  readonly requiredCandidateFields: readonly string[];
  readonly optionalCandidateFields: readonly string[];
  readonly verifies: readonly string[];
  readonly rejects: readonly string[];
}

interface CandidateFieldSummary {
  readonly allowedChangedFiles: readonly string[];
  readonly requiredCandidateFields: readonly string[];
  readonly optionalCandidateFields: readonly string[];
  readonly verifies?: readonly string[];
  readonly rejects?: readonly string[];
}

const baseRequiredCandidateFields = ["benchmarkId", "changedFiles", "fileContents"] as const;
const baseOptionalCandidateFields = ["notes", "evidence", "audit", "drift", "decomposition", "interpretedTask"] as const;

const candidateFieldSummaries: Readonly<Record<string, CandidateFieldSummary>> = {
  docs_single_file_edit: {
    allowedChangedFiles: ["README.md"],
    requiredCandidateFields: [...baseRequiredCandidateFields],
    optionalCandidateFields: ["notes"],
    verifies: ["README.md contains npm run doctor", "candidate changes only README.md"],
    rejects: ["package.json edits", "unrelated file additions", "success claims without diff evidence"]
  },
  config_single_file_edit: {
    allowedChangedFiles: ["scintilla.config.json"],
    requiredCandidateFields: [...baseRequiredCandidateFields],
    optionalCandidateFields: ["notes"],
    verifies: ["scintilla.config.json parses", "auditEverySteps is 3", "unrelated config values are preserved"],
    rejects: ["package.json edits", "README.md edits", "invalid JSON", "unrelated file additions"]
  },
  context_retrieval_only: {
    allowedChangedFiles: [],
    requiredCandidateFields: [...baseRequiredCandidateFields, "evidence"],
    optionalCandidateFields: ["notes"],
    verifies: ["repo context keeper citation", "drift detection citation", "zero-edit retrieval behavior"],
    rejects: ["file edits", "README/package-only evidence", "unrelated evidence as the only support"]
  },
  scope_violation_detection: {
    allowedChangedFiles: ["src/allowed.ts", "src/forbidden.ts"],
    requiredCandidateFields: [...baseRequiredCandidateFields, "audit"],
    optionalCandidateFields: ["notes", "evidence"],
    verifies: ["out-of-scope detection", "rollback or stop audit verdict", "src/forbidden.ts is flagged"],
    rejects: ["accepted unsafe changes", "CONTINUE verdict", "missing forbidden file flag"]
  },
  drift_detection: {
    allowedChangedFiles: [],
    requiredCandidateFields: [...baseRequiredCandidateFields, "drift"],
    optionalCandidateFields: ["notes", "evidence"],
    verifies: ["docs/config drift detection", "documentation evidence", "config or code evidence", "zero-edit audit behavior"],
    rejects: ["file edits", "claims of consistency", "drift reports without evidence"]
  },
  failing_test_single_file_fix: {
    allowedChangedFiles: ["src/math.ts"],
    requiredCandidateFields: [...baseRequiredCandidateFields],
    optionalCandidateFields: ["notes"],
    verifies: ["src/math.ts fixes clamp below-min branch", "implementation-only changed file"],
    rejects: ["test weakening", "package edits", "docs edits", "hardcoded single-value workaround"]
  },
  three_file_chain_config_test_docs: {
    allowedChangedFiles: ["README.md", "scintilla.config.json", "tests/config.test.ts"],
    requiredCandidateFields: [...baseRequiredCandidateFields, "decomposition"],
    optionalCandidateFields: ["notes"],
    verifies: ["coordinated config/test/docs update", "single-file or single-purpose decomposition", "one decomposition step per changed file"],
    rejects: ["single giant worker task", "missing decomposition", "package edits", "unrelated file additions"]
  },
  messy_prompt_resilience: {
    allowedChangedFiles: [],
    requiredCandidateFields: [...baseRequiredCandidateFields, "interpretedTask"],
    optionalCandidateFields: ["notes"],
    verifies: ["noisy prompt interpretation", "scoped auditEverySteps 5 to 3 task extraction", "non-goal extraction", "verification planning"],
    rejects: ["file edits", "completed work claims", "verification-passed claims", "broad unrelated refactor scope"]
  }
};

function getCandidateFieldSummary(benchmarkId: string): CandidateFieldSummary {
  return (
    candidateFieldSummaries[benchmarkId] ?? {
      allowedChangedFiles: [],
      requiredCandidateFields: [...baseRequiredCandidateFields],
      optionalCandidateFields: [...baseOptionalCandidateFields]
    }
  );
}

function getFixtureByBenchmarkId(benchmarkId: string) {
  return benchmarkFixtures.find((fixture) => fixture.benchmarkId === benchmarkId);
}

function buildSummary(definition: BenchmarkDefinition): ExecutableBenchmarkSummary | undefined {
  const fixture = getFixtureByBenchmarkId(definition.id);
  if (fixture === undefined) {
    return undefined;
  }

  const candidateFields = getCandidateFieldSummary(definition.id);
  const verifies = candidateFields.verifies ?? [...definition.success_criteria, ...definition.verifier_requirements];
  const rejects = candidateFields.rejects ?? definition.failure_criteria;

  return {
    benchmarkId: definition.id,
    title: definition.title,
    promptQualityLevel: definition.prompt_quality_level,
    isBaseline: definition.baseline,
    hasExecutableFixture: true,
    fixtureId: fixture.fixturePath,
    verifierId: fixture.verifierId,
    allowedChangedFiles: [...candidateFields.allowedChangedFiles],
    requiresZeroEdits: candidateFields.allowedChangedFiles.length === 0,
    requiredCandidateFields: [...candidateFields.requiredCandidateFields],
    optionalCandidateFields: [...candidateFields.optionalCandidateFields],
    verifies: [...verifies],
    rejects: [...rejects]
  };
}

export function listExecutableBenchmarks(): ExecutableBenchmarkSummary[] {
  return benchmarkRegistry.flatMap((definition) => {
    const summary = buildSummary(definition);
    return summary === undefined ? [] : [summary];
  });
}

export function getExecutableBenchmarkSummary(benchmarkId: string): ExecutableBenchmarkSummary | undefined {
  const definition = benchmarkRegistry.find((benchmark) => benchmark.id === benchmarkId);
  return definition === undefined ? undefined : buildSummary(definition);
}
