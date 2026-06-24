/**
 * ikbi user-facing system-error catalog.
 *
 * The translator (`translator.ts`) maps PROVIDER/MODEL failures to friendly messages. This
 * module is its sibling for the OTHER half: raw Node.js SYSCALL errors (EACCES, ENOENT,
 * ENOSPC, …) that surface from the filesystem, child processes, and sockets. A bare
 * "Error: EACCES: permission denied, open '/etc/foo'" tells a user nothing actionable; the
 * catalog turns each `err.code` into a one-line explanation + a specific next step, splicing
 * in the offending `path`/`syscall` when the error carries them.
 *
 * Dependency-free and pure (it only reads the error's own fields), so it can be consulted
 * from any layer. The translator calls `translateSystemError` as a fallback whenever its own
 * provider-shaped classification comes up empty, so a raw OS error never reaches the user as
 * a stack trace.
 */

import type { FriendlyError } from "./translator.js";

/** One catalog entry: a plain-language cause + an actionable next step. */
interface CatalogEntry {
  /** What went wrong, in plain language (the `path` is appended by the caller when known). */
  readonly cause: string;
  /** A specific, actionable next step. */
  readonly suggestion: string;
}

/**
 * The top OS/syscall error codes ikbi can surface, each with a friendly cause + suggestion.
 * Codes are the Node.js `err.code` values (see `man 2 open` / libuv). ≥20 entries — the set
 * a CLI realistically hits across file I/O, process spawn, and socket operations.
 */
export const SYSTEM_ERROR_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  EACCES: { cause: "Permission denied.", suggestion: "Check the file/directory permissions, or run from a location you own. Avoid sudo — fix ownership instead (chown)." },
  EPERM: { cause: "Operation not permitted.", suggestion: "The OS blocked this action. Check ownership/permissions; on macOS, grant the terminal Full Disk Access if it touches a protected path." },
  ENOENT: { cause: "No such file or directory.", suggestion: "Check the path is spelled correctly and exists. If it's ikbi state, run `ikbi doctor --fix` to create the missing dirs." },
  ENOTDIR: { cause: "A path component is not a directory.", suggestion: "One element of the path is a file where a directory was expected. Check the path." },
  EISDIR: { cause: "Expected a file but found a directory.", suggestion: "Point the command at a file, not a directory." },
  EEXIST: { cause: "The file or directory already exists.", suggestion: "Remove or rename the existing target, or choose a different name." },
  ENOTEMPTY: { cause: "The directory is not empty.", suggestion: "Empty the directory first, or use a force/recursive option if you meant to remove its contents." },
  ENOSPC: { cause: "No space left on the device.", suggestion: "Free up disk space (try `ikbi clean` to reclaim old worktrees), then retry." },
  EROFS: { cause: "The filesystem is read-only.", suggestion: "Write to a writable location, or remount the filesystem read-write." },
  EMFILE: { cause: "Too many open files (per-process limit reached).", suggestion: "Raise the open-file limit (`ulimit -n`), or close other programs and retry." },
  ENFILE: { cause: "Too many open files (system-wide limit reached).", suggestion: "Close other programs to free file descriptors, then retry." },
  ENOMEM: { cause: "Out of memory.", suggestion: "Free up RAM (close other programs), or run a smaller task / use a lighter model." },
  EBUSY: { cause: "The resource is busy or locked.", suggestion: "Another process is using this file/dir. Close it (or wait), then retry." },
  EAGAIN: { cause: "The resource is temporarily unavailable.", suggestion: "Transient — wait a moment and try again." },
  ELOOP: { cause: "Too many symbolic links in the path.", suggestion: "A symlink loop was hit. Check for a circular symlink in the path." },
  EXDEV: { cause: "Cross-device link not allowed.", suggestion: "Source and destination are on different filesystems. Copy instead of move, or keep them on one device." },
  ENAMETOOLONG: { cause: "The path is too long.", suggestion: "Shorten the path or move the project closer to the filesystem root." },
  EADDRINUSE: { cause: "The network address/port is already in use.", suggestion: "Another process holds the port. Stop it, or start ikbi on a different port: `ikbi serve --port <n>`." },
  EADDRNOTAVAIL: { cause: "The requested address is not available.", suggestion: "Bind to a valid local address (e.g. localhost), or check the --host value." },
  ECONNREFUSED: { cause: "The connection was refused.", suggestion: "Nothing is listening at that address. Check the service is running and the host:port is correct (and egress-allowlisted)." },
  ECONNRESET: { cause: "The connection was reset by the peer.", suggestion: "The remote closed the connection. Retry; if it persists, check the service and your network." },
  ETIMEDOUT: { cause: "The operation timed out.", suggestion: "The remote did not respond in time. Check connectivity and retry." },
  ENOTFOUND: { cause: "The host could not be resolved (DNS).", suggestion: "Check the hostname and your internet/DNS, and that the host is on the egress allowlist." },
  EHOSTUNREACH: { cause: "The host is unreachable.", suggestion: "Check your network route to the host and any firewall/VPN." },
  ENETUNREACH: { cause: "The network is unreachable.", suggestion: "Check your internet connection and routing, then retry." },
  EPIPE: { cause: "The write end of a pipe was closed early.", suggestion: "Usually harmless (e.g. piping to `head`). If unexpected, check the downstream command." },
};

/** Read a Node syscall error's `code`, if present (e.g. "ENOENT"). */
export function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/** Read a Node syscall error's `path`, if present. */
function errorPath(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "path" in err) {
    const p = (err as { path?: unknown }).path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

/** Read a Node syscall error's `syscall`, if present (e.g. "open", "spawn"). */
function errorSyscall(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "syscall" in err) {
    const s = (err as { syscall?: unknown }).syscall;
    if (typeof s === "string" && s.length > 0) return s;
  }
  return undefined;
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Translate a raw Node SYSCALL error into a `FriendlyError`, or `undefined` if the error
 * carries no catalogued `code` (so the caller can fall back to its own handling). The
 * message splices in the offending `path` and `syscall` when the error supplies them.
 */
export function translateSystemError(err: unknown): FriendlyError | undefined {
  const code = errorCode(err);
  if (code === undefined) return undefined;
  const entry = SYSTEM_ERROR_CATALOG[code];
  if (entry === undefined) return undefined;

  const path = errorPath(err);
  const syscall = errorSyscall(err);
  const where = path !== undefined ? ` (${path})` : syscall !== undefined ? ` (during ${syscall})` : "";
  return {
    category: "unknown",
    message: `${entry.cause}${where}`,
    suggestion: entry.suggestion,
    technical: `${code}: ${rawMessage(err)}`,
  };
}
