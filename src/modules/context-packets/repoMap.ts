/**
 * ikbi context-packets — REPO MAP (classified, section-bucketed repo structure).
 *
 * Folds a raw RepoContextSnapshot into the four sections a coding task cares about —
 * source, tests, docs, config — plus an "other" bucket and the ignored-context list.
 * Classification is deterministic (path + filename + extension rules), the output is
 * sorted, and the totals are exact. This is the map the context packet's repoSummary
 * is built from, so a small model sees the repo's SHAPE before it sees any file body.
 *
 * Ported from scintilla/src/core/context/repoMap.ts. Standalone.
 */

import path from "node:path";
import type { RepoContextFileEntry, RepoContextSnapshot } from "./repoScanner.js";

export interface RepoContextFileSummary extends RepoContextFileEntry {
  readonly reason: string;
}

export interface RepoIgnoredContextSummary {
  readonly path: string;
  readonly reason: string;
}

export interface RepoContextMap {
  readonly generatedAt: string;
  readonly root: string;
  readonly packageManager: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly sections: {
    readonly source: readonly RepoContextFileSummary[];
    readonly tests: readonly RepoContextFileSummary[];
    readonly docs: readonly RepoContextFileSummary[];
    readonly config: readonly RepoContextFileSummary[];
    readonly other: readonly RepoContextFileSummary[];
    readonly ignoredContext: readonly RepoIgnoredContextSummary[];
  };
  readonly totals: {
    readonly files: number;
    readonly source: number;
    readonly tests: number;
    readonly docs: number;
    readonly config: number;
    readonly other: number;
    readonly ignoredDirs: number;
    readonly totalBytes: number;
  };
  readonly warnings: readonly string[];
}

type FileSection = "source" | "tests" | "docs" | "config" | "other";

const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const testFilePattern = /\.(test|spec)\.(ts|tsx|js|jsx)$/i;
const configFilePattern = /(^|\/)(vitest\.config|eslint\.config|prettier\.config|[^/]+\.config)\.(ts|js|json)$/i;

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function comparePath(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function fileName(filePath: string): string {
  const normalized = normalizePath(filePath);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isUnderDirectory(filePath: string, directoryName: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized === directoryName || normalized.startsWith(`${directoryName}/`) || normalized.includes(`/${directoryName}/`);
}

function isTestFile(file: RepoContextFileEntry): boolean {
  const normalized = normalizePath(file.path);
  return isUnderDirectory(normalized, "test") || isUnderDirectory(normalized, "tests") || testFilePattern.test(fileName(normalized));
}

function isDocsFile(file: RepoContextFileEntry): boolean {
  const normalized = normalizePath(file.path);
  return file.extension === ".md" || normalized.startsWith("docs/") || fileName(normalized).toLowerCase() === "readme.md";
}

function isConfigFile(file: RepoContextFileEntry): boolean {
  const normalized = normalizePath(file.path);
  const name = fileName(normalized).toLowerCase();

  if (name === "package.json") {
    return true;
  }

  if (/^tsconfig.*\.json$/i.test(name)) {
    return true;
  }

  if (configFilePattern.test(normalized)) {
    return true;
  }

  return file.extension === ".json" && name !== "package-lock.json" && name !== "pnpm-lock.yaml";
}

function isSourceFile(file: RepoContextFileEntry): boolean {
  const normalized = normalizePath(file.path);
  return codeExtensions.has(file.extension) && (normalized.startsWith("src/") || normalized.startsWith("lib/"));
}

function classifyFile(file: RepoContextFileEntry): { section: FileSection; reason: string } {
  if (isTestFile(file)) {
    return {
      section: "tests",
      reason: "test path or test/spec filename"
    };
  }

  if (isDocsFile(file)) {
    return {
      section: "docs",
      reason: "Markdown or docs path"
    };
  }

  if (isConfigFile(file)) {
    return {
      section: "config",
      reason: "package, TypeScript, tool, config, or JSON metadata"
    };
  }

  if (isSourceFile(file)) {
    return {
      section: "source",
      reason: "source code under src/ or lib/"
    };
  }

  return {
    section: "other",
    reason: "included file did not match source, test, docs, or config rules"
  };
}

function summarizeFile(file: RepoContextFileEntry, reason: string): RepoContextFileSummary {
  return {
    path: normalizePath(file.path),
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    reason
  };
}

export function buildRepoContextMap(snapshot: RepoContextSnapshot): RepoContextMap {
  const sections = {
    source: [] as RepoContextFileSummary[],
    tests: [] as RepoContextFileSummary[],
    docs: [] as RepoContextFileSummary[],
    config: [] as RepoContextFileSummary[],
    other: [] as RepoContextFileSummary[]
  };

  const sortedFiles = [...snapshot.files].sort((left, right) => comparePath(normalizePath(left.path), normalizePath(right.path)));

  for (const file of sortedFiles) {
    const classification = classifyFile(file);
    sections[classification.section].push(summarizeFile(file, classification.reason));
  }

  const ignoredContext = [...snapshot.ignoredDirs]
    .map((ignoredDir) => ({
      path: normalizePath(ignoredDir),
      reason: "scanner ignored generated, dependency, cache, or VCS context"
    }))
    .sort((left, right) => comparePath(left.path, right.path));

  return {
    generatedAt: snapshot.generatedAt,
    root: snapshot.root,
    packageManager: snapshot.packageManager,
    scripts: { ...snapshot.scripts },
    sections: {
      ...sections,
      ignoredContext
    },
    totals: {
      files: sortedFiles.length,
      source: sections.source.length,
      tests: sections.tests.length,
      docs: sections.docs.length,
      config: sections.config.length,
      other: sections.other.length,
      ignoredDirs: ignoredContext.length,
      totalBytes: sortedFiles.reduce((total, file) => total + file.sizeBytes, 0)
    },
    warnings: snapshot.warnings.map((warning) => (warning.path === undefined ? `${warning.code}: ${warning.message}` : `${warning.code}: ${warning.path}: ${warning.message}`))
  };
}
