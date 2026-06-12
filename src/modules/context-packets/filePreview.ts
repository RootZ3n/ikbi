/**
 * ikbi context-packets — FILE PREVIEW (byte-budgeted, confinement-safe).
 *
 * Reads a bounded UTF-8 prefix of each requested repo file so a small-context model
 * gets the SHAPE of the relevant files without blowing its window. Every path is
 * re-confined to the repo root before a single byte is read: absolute paths, `..`
 * traversal, symlinks (at any path segment), and out-of-root resolutions are SKIPPED
 * with a recorded reason rather than read. The per-file and total byte budgets are
 * hard ceilings — the previews fit the budget or they are truncated/dropped.
 *
 * Ported from scintilla/src/core/context/filePreview.ts (the same primitive the
 * evaluation framework uses). Standalone — no shared dependency with the trio.
 */

import { lstat, open } from "node:fs/promises";
import path from "node:path";

const defaultAllowedExtensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".md"] as const;
const defaultMaxBytesPerFile = 8 * 1024;
const defaultMaxTotalBytes = 32 * 1024;

export interface FilePreviewOptions {
  readonly maxBytesPerFile?: number;
  readonly maxTotalBytes?: number;
  readonly allowedExtensions?: readonly string[];
}

export interface FilePreview {
  readonly path: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly text: string;
}

export interface FilePreviewSkip {
  readonly path: string;
  readonly reason: string;
}

export interface FilePreviewResult {
  readonly repoRoot: string;
  readonly previews: readonly FilePreview[];
  readonly skipped: readonly FilePreviewSkip[];
  readonly totalBytesRead: number;
  readonly warnings: readonly string[];
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]+/).filter(Boolean).join("/");
}

function hasTraversal(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).includes("..");
}

function isInsideRoot(root: string, candidatePath: string): boolean {
  const relativePath = path.relative(root, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function pathContainsSymlink(root: string, normalizedRelativePath: string): Promise<string | undefined> {
  const parts = normalizedRelativePath.split("/");
  let currentPath = root;

  for (const part of parts) {
    currentPath = path.join(currentPath, part);
    const stats = await lstat(currentPath);
    if (stats.isSymbolicLink()) {
      return normalizeRelativePath(path.relative(root, currentPath));
    }
  }

  return undefined;
}

async function readBoundedUtf8(filePath: string, bytesToRead: number): Promise<{ bytesRead: number; text: string }> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      bytesRead: result.bytesRead,
      text: buffer.subarray(0, result.bytesRead).toString("utf8")
    };
  } finally {
    await handle.close();
  }
}

export async function previewRepoFiles(repoRoot: string, relativePaths: readonly string[], options: FilePreviewOptions = {}): Promise<FilePreviewResult> {
  const resolvedRoot = path.resolve(repoRoot);
  const maxBytesPerFile = options.maxBytesPerFile ?? defaultMaxBytesPerFile;
  const maxTotalBytes = options.maxTotalBytes ?? defaultMaxTotalBytes;
  const allowedExtensions = new Set(options.allowedExtensions ?? defaultAllowedExtensions);
  const previews: FilePreview[] = [];
  const skipped: FilePreviewSkip[] = [];
  const warnings: string[] = [];
  let totalBytesRead = 0;

  let rootStats;
  try {
    rootStats = await lstat(resolvedRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repoRoot: resolvedRoot,
      previews,
      skipped: relativePaths.map((relativePath) => ({
        path: relativePath,
        reason: "repo root could not be read"
      })),
      totalBytesRead,
      warnings: [`repo_root_error: ${message}`]
    };
  }

  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    const reason = rootStats.isSymbolicLink() ? "repo root must not be a symlink" : "repo root must be a directory";
    return {
      repoRoot: resolvedRoot,
      previews,
      skipped: relativePaths.map((relativePath) => ({
        path: relativePath,
        reason
      })),
      totalBytesRead,
      warnings: [reason]
    };
  }

  for (const requestedPath of relativePaths) {
    const normalizedPath = normalizeRelativePath(requestedPath);

    if (requestedPath.length === 0 || normalizedPath.length === 0) {
      skipped.push({
        path: requestedPath,
        reason: "path must be a non-empty relative path"
      });
      continue;
    }

    if (path.isAbsolute(requestedPath)) {
      skipped.push({
        path: requestedPath,
        reason: "absolute paths are not allowed"
      });
      continue;
    }

    if (hasTraversal(requestedPath)) {
      skipped.push({
        path: requestedPath,
        reason: "path traversal is not allowed"
      });
      continue;
    }

    const resolvedPath = path.resolve(resolvedRoot, normalizedPath);
    if (!isInsideRoot(resolvedRoot, resolvedPath)) {
      skipped.push({
        path: requestedPath,
        reason: "resolved path escapes repo root"
      });
      continue;
    }

    let symlinkPath: string | undefined;
    try {
      symlinkPath = await pathContainsSymlink(resolvedRoot, normalizedPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      skipped.push({
        path: requestedPath,
        reason: nodeError.code === "ENOENT" ? "file does not exist" : "path could not be inspected"
      });
      continue;
    }

    if (symlinkPath !== undefined) {
      skipped.push({
        path: requestedPath,
        reason: `symlinks are not followed (${symlinkPath})`
      });
      continue;
    }

    let stats;
    try {
      stats = await lstat(resolvedPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      skipped.push({
        path: requestedPath,
        reason: nodeError.code === "ENOENT" ? "file does not exist" : "file could not be inspected"
      });
      continue;
    }

    if (stats.isDirectory()) {
      skipped.push({
        path: requestedPath,
        reason: "directories cannot be previewed"
      });
      continue;
    }

    if (!stats.isFile()) {
      skipped.push({
        path: requestedPath,
        reason: "path is not a regular file"
      });
      continue;
    }

    const extension = path.extname(normalizedPath);
    if (!allowedExtensions.has(extension)) {
      skipped.push({
        path: requestedPath,
        reason: `unsupported extension: ${extension || "(none)"}`
      });
      continue;
    }

    const remainingBytes = maxTotalBytes - totalBytesRead;
    if (remainingBytes <= 0) {
      skipped.push({
        path: requestedPath,
        reason: "total byte budget exceeded"
      });
      continue;
    }

    const bytesToRead = Math.min(stats.size, maxBytesPerFile, remainingBytes);
    const preview = await readBoundedUtf8(resolvedPath, bytesToRead);
    totalBytesRead += preview.bytesRead;

    previews.push({
      path: normalizedPath,
      extension,
      sizeBytes: stats.size,
      bytesRead: preview.bytesRead,
      truncated: stats.size > preview.bytesRead,
      text: preview.text
    });
  }

  return {
    repoRoot: resolvedRoot,
    previews,
    skipped,
    totalBytesRead,
    warnings
  };
}
