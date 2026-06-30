/**
 * ikbi consult — CODE SLICE reader (verbatim line ranges, confinement-safe).
 *
 * Reads a 1-based inclusive line range out of a repo file, VERBATIM, so the frontier
 * model reasons over real code rather than a summary of it. Every path is re-confined to
 * the repo root before a single byte is read — absolute paths, `..` traversal, symlinks
 * (at any path segment), and out-of-root resolutions are SKIPPED with a recorded reason
 * rather than read. The same confinement discipline as context-packets/filePreview, but
 * reading an arbitrary line WINDOW instead of a leading byte prefix.
 *
 * Bounds: each file is read up to `maxFileReadBytes` (a hard ceiling so a finding pointing
 * deep into a huge file cannot load it all); each returned slice's text is capped at
 * `maxSliceBytes`. A range that falls beyond the bounded read is clamped and flagged
 * `truncated` — never silently dropped.
 *
 * Standalone — no shared dependency; mirrors filePreview's primitives by design.
 */

import { lstat, open } from "node:fs/promises";
import path from "node:path";

import type { CodeSlice, CodeSliceSkip, ConsultSliceRequest } from "./contract.js";

const defaultMaxSliceBytes = 8 * 1024;
const defaultMaxFileReadBytes = 512 * 1024;

export interface CodeSliceOptions {
  /** Per-slice text byte cap. */
  readonly maxSliceBytes?: number;
  /** Hard ceiling on bytes read from any single file (bounds memory on huge files). */
  readonly maxFileReadBytes?: number;
}

export interface CodeSliceReadResult {
  readonly slice?: CodeSlice;
  readonly skip?: CodeSliceSkip;
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

async function readBoundedUtf8(filePath: string, bytesToRead: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Cap a string to a hard UTF-8 byte budget (may trim a trailing multibyte char). */
function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function skip(request: ConsultSliceRequest, reason: string): CodeSliceReadResult {
  return {
    skip: { path: request.path, startLine: request.startLine, endLine: request.endLine, reason }
  };
}

/**
 * Read one slice request. Returns either a `slice` (success) or a `skip` (with reason).
 * Never throws on a per-file error — fs failures become a recorded skip.
 */
export async function readCodeSlice(
  repoRoot: string,
  request: ConsultSliceRequest,
  options: CodeSliceOptions = {}
): Promise<CodeSliceReadResult> {
  const maxSliceBytes = options.maxSliceBytes ?? defaultMaxSliceBytes;
  const maxFileReadBytes = options.maxFileReadBytes ?? defaultMaxFileReadBytes;
  const resolvedRoot = path.resolve(repoRoot);
  const normalizedPath = normalizeRelativePath(request.path);

  if (request.path.length === 0 || normalizedPath.length === 0) {
    return skip(request, "path must be a non-empty relative path");
  }
  if (!Number.isInteger(request.startLine) || !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < 1) {
    return skip(request, "line numbers must be positive integers");
  }
  if (request.startLine > request.endLine) {
    return skip(request, "startLine must be <= endLine");
  }
  if (path.isAbsolute(request.path)) {
    return skip(request, "absolute paths are not allowed");
  }
  if (hasTraversal(request.path)) {
    return skip(request, "path traversal is not allowed");
  }

  const resolvedPath = path.resolve(resolvedRoot, normalizedPath);
  if (!isInsideRoot(resolvedRoot, resolvedPath)) {
    return skip(request, "resolved path escapes repo root");
  }

  let symlinkPath: string | undefined;
  try {
    symlinkPath = await pathContainsSymlink(resolvedRoot, normalizedPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return skip(request, nodeError.code === "ENOENT" ? "file does not exist" : "path could not be inspected");
  }
  if (symlinkPath !== undefined) {
    return skip(request, `symlinks are not followed (${symlinkPath})`);
  }

  let stats;
  try {
    stats = await lstat(resolvedPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return skip(request, nodeError.code === "ENOENT" ? "file does not exist" : "file could not be inspected");
  }
  if (stats.isDirectory()) {
    return skip(request, "directories cannot be sliced");
  }
  if (!stats.isFile()) {
    return skip(request, "path is not a regular file");
  }

  const bytesToRead = Math.min(stats.size, maxFileReadBytes);
  const fileReadBounded = stats.size > maxFileReadBytes;
  let content: string;
  try {
    content = await readBoundedUtf8(resolvedPath, bytesToRead);
  } catch {
    return skip(request, "file could not be read");
  }

  const lines = content.split("\n");
  // A terminating newline yields a trailing empty element that is not a real line.
  if (content.endsWith("\n")) {
    lines.pop();
  } else if (fileReadBounded && lines.length > 0) {
    // A bounded read cut mid-line; that last fragment is not a trustworthy full line.
    lines.pop();
  }
  const availableLines = lines.length;
  if (request.startLine > availableLines) {
    return skip(
      request,
      fileReadBounded
        ? `startLine ${request.startLine} is beyond the bounded read (${availableLines} lines of ${maxFileReadBytes} bytes)`
        : `startLine ${request.startLine} is beyond end of file (${availableLines} lines)`
    );
  }

  const clampedEnd = Math.min(request.endLine, availableLines);
  const rangeTruncated = clampedEnd < request.endLine;
  const sliceText = lines.slice(request.startLine - 1, clampedEnd).join("\n");
  const capped = capBytes(sliceText, maxSliceBytes);

  return {
    slice: {
      path: normalizedPath,
      startLine: request.startLine,
      endLine: clampedEnd,
      text: capped.text,
      truncated: capped.truncated || rangeTruncated,
      bytes: Buffer.byteLength(capped.text, "utf8")
    }
  };
}
