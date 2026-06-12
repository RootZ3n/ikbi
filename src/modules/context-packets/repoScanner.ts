/**
 * ikbi context-packets — REPO SCANNER (deterministic filesystem snapshot).
 *
 * Walks a repo root once, ignoring generated/dependency/cache/VCS directories, and
 * records every source-ish file (.ts/.tsx/.js/.jsx/.json/.md) with its size + mtime.
 * Detects the package manager from the lockfile and reads package.json scripts. The
 * walk is confinement-safe (no symlink-following, no escape past the root) and stable
 * (entries sorted) so the snapshot — and the repo map / context packet built from it —
 * is reproducible.
 *
 * `scanRepo()` is the one-call convenience the tournament + patchsmith use: it scans
 * and builds the classified RepoContextMap in a single step.
 *
 * Ported from scintilla/src/core/context/{repoScanner,repoSnapshot}.ts. Standalone.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildRepoContextMap, type RepoContextMap } from "./repoMap.js";

export type RepoPackageManager = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

export interface RepoContextFileEntry {
  readonly path: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface RepoContextWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface RepoContextSnapshot {
  readonly generatedAt: string;
  readonly root: string;
  readonly packageManager: RepoPackageManager;
  readonly scripts: Readonly<Record<string, string>>;
  readonly files: readonly RepoContextFileEntry[];
  readonly ignoredDirs: readonly string[];
  readonly warnings: readonly RepoContextWarning[];
}

export const repoScannerIgnoredDirs = [".cache", ".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"] as const;
export const repoScannerIncludedExtensions = [".js", ".jsx", ".json", ".md", ".ts", ".tsx"] as const;

const ignoredDirSet = new Set<string>(repoScannerIgnoredDirs);
const includedExtensionSet = new Set<string>(repoScannerIncludedExtensions);

interface PackageJsonShape {
  readonly scripts?: unknown;
}

function createEmptySnapshot(root: string, warnings: readonly RepoContextWarning[]): RepoContextSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    root: path.resolve(root),
    packageManager: "unknown",
    scripts: {},
    files: [],
    ignoredDirs: [...repoScannerIgnoredDirs],
    warnings
  };
}

function toRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isInsideRoot(root: string, candidatePath: string): boolean {
  const relativePath = path.relative(root, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeScripts(parsed: PackageJsonShape): Readonly<Record<string, string>> {
  if (parsed.scripts === null || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed.scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

async function detectPackageManager(root: string): Promise<RepoPackageManager> {
  const lockfiles: readonly [string, RepoPackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"]
  ];

  for (const [fileName, packageManager] of lockfiles) {
    try {
      const stats = await lstat(path.join(root, fileName));
      if (stats.isFile()) {
        return packageManager;
      }
    } catch {
      // Missing lockfiles are expected.
    }
  }

  return "unknown";
}

async function readPackageScripts(root: string, warnings: RepoContextWarning[]): Promise<Readonly<Record<string, string>>> {
  const packageJsonPath = path.join(root, "package.json");

  try {
    const stats = await lstat(packageJsonPath);
    if (stats.isSymbolicLink()) {
      warnings.push({
        code: "symlink_skipped",
        message: "package.json is a symlink and was not read",
        path: "package.json"
      });
      return {};
    }

    if (!stats.isFile()) {
      return {};
    }
  } catch {
    return {};
  }

  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJsonShape;
    return normalizeScripts(parsed);
  } catch (error) {
    warnings.push({
      code: "package_json_parse_error",
      message: error instanceof Error ? error.message : String(error),
      path: "package.json"
    });
    return {};
  }
}

async function scanDirectory(root: string, directory: string, files: RepoContextFileEntry[], warnings: RepoContextWarning[]): Promise<void> {
  const entries = [...(await readdir(directory))].sort((left, right) => left.localeCompare(right));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry);
    if (!isInsideRoot(root, absolutePath)) {
      warnings.push({
        code: "path_outside_root",
        message: "scanner skipped a path outside the repo root",
        path: toRelativePath(root, absolutePath)
      });
      continue;
    }

    const relativePath = toRelativePath(root, absolutePath);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      warnings.push({
        code: "lstat_failed",
        message: error instanceof Error ? error.message : String(error),
        path: relativePath
      });
      continue;
    }

    if (stats.isSymbolicLink()) {
      warnings.push({
        code: "symlink_skipped",
        message: "symlink was not followed",
        path: relativePath
      });
      continue;
    }

    if (stats.isDirectory()) {
      if (ignoredDirSet.has(entry)) {
        continue;
      }

      await scanDirectory(root, absolutePath, files, warnings);
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    const extension = path.extname(entry);
    if (!includedExtensionSet.has(extension)) {
      continue;
    }

    files.push({
      path: relativePath,
      extension,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs
    });
  }
}

export async function scanRepoContext(root: string): Promise<RepoContextSnapshot> {
  const resolvedRoot = path.resolve(root);
  const warnings: RepoContextWarning[] = [];

  let rootStats;
  try {
    rootStats = await lstat(resolvedRoot);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return createEmptySnapshot(root, [
      {
        code: nodeError.code === "ENOENT" ? "root_not_found" : "root_lstat_failed",
        message: nodeError.message,
        path: resolvedRoot
      }
    ]);
  }

  if (rootStats.isSymbolicLink()) {
    return createEmptySnapshot(root, [
      {
        code: "root_is_symlink",
        message: "repo root must not be a symlink",
        path: resolvedRoot
      }
    ]);
  }

  if (!rootStats.isDirectory()) {
    return createEmptySnapshot(root, [
      {
        code: "root_not_directory",
        message: "repo root must be a directory",
        path: resolvedRoot
      }
    ]);
  }

  const files: RepoContextFileEntry[] = [];
  await scanDirectory(resolvedRoot, resolvedRoot, files, warnings);

  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    generatedAt: new Date().toISOString(),
    root: resolvedRoot,
    packageManager: await detectPackageManager(resolvedRoot),
    scripts: await readPackageScripts(resolvedRoot, warnings),
    files,
    ignoredDirs: [...repoScannerIgnoredDirs],
    warnings
  };
}

/**
 * One-call convenience: scan the repo and return the classified RepoContextMap (the
 * shape `buildContextPacket` consumes). This is the seam the tournament + patchsmith
 * call — `repoMap: await scanRepo(workspace.path)`.
 */
export async function scanRepo(root: string): Promise<RepoContextMap> {
  return buildRepoContextMap(await scanRepoContext(root));
}
