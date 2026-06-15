/**
 * ikbi `audit <repo>` — read-only diagnostic snapshot of a target repository.
 *
 * Inspects the repo WITHOUT creating workspaces or running builds:
 *   - Repo type (Node.js/Rust/Go/Python/unknown) and package manager
 *   - Test commands, tsconfig presence, lockfile status
 *   - Active workspace status for this repo
 *   - Last build result and recent receipt history
 *
 * This is a diagnostic tool for operators before or after a build: understand
 * the repo's posture quickly without touching anything.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { registerCommand } from "./registry.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt } from "../core/receipt/index.js";

/** The surfaces audit needs — all injectable for tests. */
export interface AuditDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly workspaces?: { list(): Promise<WorkspaceRecord[]> };
  readonly receipts?: { query(): Promise<Receipt[]> };
  /** Check whether a path exists. Default: fs.access. */
  readonly fileExists?: (path: string) => Promise<boolean>;
  /** Read a file as UTF-8 text. Default: fs.readFile. */
  readonly readFileText?: (path: string) => Promise<string>;
}

/** Detected information about a repository. All fields are best-effort. */
export interface AuditResult {
  readonly repoType: string;
  readonly packageManager: string | undefined;
  readonly testCommand: string | undefined;
  readonly hasTypeScript: boolean;
  readonly lockfile: string | undefined;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly lastBuildReceipt: Receipt | undefined;
  readonly repoReceiptCount: number;
}

const NONE = "(none)";
const UNKNOWN = "(unknown)";

async function checkExists(fileExists: (p: string) => Promise<boolean>, ...paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (await fileExists(p)) return true;
  }
  return false;
}

/** Detect the primary repo type from indicator files. */
async function detectRepoType(repoPath: string, fileExists: (p: string) => Promise<boolean>): Promise<string> {
  if (await fileExists(join(repoPath, "Cargo.toml"))) return "Rust";
  if (await fileExists(join(repoPath, "go.mod"))) return "Go";
  if (await fileExists(join(repoPath, "pyproject.toml"))) return "Python (pyproject.toml)";
  if (await fileExists(join(repoPath, "requirements.txt"))) return "Python (requirements.txt)";
  if (await fileExists(join(repoPath, "package.json"))) return "Node.js";
  return UNKNOWN;
}

/** Detect the Node.js package manager from lockfiles. */
async function detectPackageManager(repoPath: string, fileExists: (p: string) => Promise<boolean>): Promise<string | undefined> {
  if (await fileExists(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(repoPath, "bun.lockb"))) return "bun";
  if (await fileExists(join(repoPath, "yarn.lock"))) return "yarn";
  if (await fileExists(join(repoPath, "package-lock.json"))) return "npm";
  return undefined;
}

/** Find the first lockfile that exists. */
async function detectLockfile(repoPath: string, fileExists: (p: string) => Promise<boolean>): Promise<string | undefined> {
  const candidates = ["pnpm-lock.yaml", "bun.lockb", "yarn.lock", "package-lock.json", "Cargo.lock", "go.sum"];
  for (const name of candidates) {
    if (await fileExists(join(repoPath, name))) return name;
  }
  return undefined;
}

/** Read test script from package.json scripts.test (Node.js repos only). */
async function detectTestCommand(
  repoPath: string,
  pkgMgr: string | undefined,
  fileExists: (p: string) => Promise<boolean>,
  readFileText: (p: string) => Promise<string>,
): Promise<string | undefined> {
  const pkgPath = join(repoPath, "package.json");
  if (!(await fileExists(pkgPath))) return undefined;
  try {
    const raw = await readFileText(pkgPath);
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    const testScript = scripts?.test;
    if (typeof testScript === "string" && testScript.length > 0 && testScript !== "echo \"Error: no test specified\" && exit 1") {
      return `${pkgMgr ?? "npm"} test`;
    }
  } catch {
    // unreadable or unparseable package.json — skip
  }
  return undefined;
}

/** Find all workspace records for the target repo. */
async function workspacesFor(repoPath: string, ws: { list(): Promise<WorkspaceRecord[]> }): Promise<WorkspaceRecord[]> {
  try {
    const all = await ws.list();
    return all.filter((r) => r.targetRepo === repoPath);
  } catch {
    return [];
  }
}

/** Find the most recent build-related receipt for this repo, and count all matching. */
async function receiptInfoFor(repoPath: string, rc: { query(): Promise<Receipt[]> }): Promise<{ last: Receipt | undefined; count: number }> {
  try {
    const all = await rc.query();
    const matching = all.filter((r) => r.project === repoPath || (r.metadata as Record<string, unknown> | undefined)?.targetRepo === repoPath);
    const builds = matching.filter((r) => r.operation === "worker.run.summary" || r.operation === "workspace.promote" || r.operation === "workspace.undo");
    builds.sort((a, b) => b.seq - a.seq);
    return { last: builds[0], count: matching.length };
  } catch {
    return { last: undefined, count: 0 };
  }
}

/** Build the `audit` handler. */
export function createAuditCli(deps: AuditDeps = {}) {
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const ws = deps.workspaces ?? coreWorkspaces;
  const rc = deps.receipts ?? coreReceipts;

  const fileExists = deps.fileExists ?? ((p: string) => access(p).then(() => true, () => false));
  const readFileText = deps.readFileText ?? ((p: string) => readFile(p, "utf8"));

  async function audit(argv: readonly string[]): Promise<void> {
    const repoPath = argv[0];
    if (repoPath === undefined || repoPath.length === 0) {
      err("ikbi audit: a repo path is required — usage: ikbi audit <repo>\n");
      setExit(1);
      return;
    }

    // Verify the repo path exists before doing anything else.
    const repoExists = await fileExists(repoPath);
    if (!repoExists) {
      err(`ikbi audit: repo path not found: "${repoPath}"\n`);
      setExit(1);
      return;
    }

    // Gather all repo info in parallel — each probe is independent.
    const [repoType, pkgMgr, lockfile, hasTs, wsList, receiptInfo] = await Promise.all([
      detectRepoType(repoPath, fileExists),
      detectPackageManager(repoPath, fileExists),
      detectLockfile(repoPath, fileExists),
      checkExists(fileExists, join(repoPath, "tsconfig.json"), join(repoPath, "tsconfig.base.json")),
      workspacesFor(repoPath, ws),
      receiptInfoFor(repoPath, rc),
    ]);
    const testCmd = await detectTestCommand(repoPath, pkgMgr, fileExists, readFileText);

    // ── Repo identity ──────────────────────────────────────────────────────────
    out(`Repo:            ${repoPath}\n`);
    out(`Type:            ${repoType}\n`);
    out(`Package manager: ${pkgMgr ?? NONE}\n`);
    out(`Test command:    ${testCmd ?? NONE}\n`);
    out(`TypeScript:      ${hasTs ? "yes (tsconfig.json present)" : "no"}\n`);
    out(`Lockfile:        ${lockfile ?? NONE}\n`);
    out(`\n`);

    // ── Workspace status ───────────────────────────────────────────────────────
    if (wsList.length === 0) {
      out(`Workspaces:      (none)\n`);
    } else {
      out(`Workspaces:      ${wsList.length} workspace(s)\n`);
      const idW = Math.max(2, ...wsList.map((r) => r.id.length));
      const stW = Math.max(5, ...wsList.map((r) => r.state.length));
      for (const r of wsList) {
        out(`  ${r.id.padEnd(idW)}  ${r.state.padEnd(stW)}  ${r.path}\n`);
      }
    }
    out(`\n`);

    // ── Last build + receipt history ───────────────────────────────────────────
    out(`Receipt history: ${receiptInfo.count} receipt(s) involving this repo\n`);
    if (receiptInfo.last !== undefined) {
      const ts = new Date(receiptInfo.last.timestamp).toISOString();
      const meta = receiptInfo.last.metadata as Record<string, unknown> | undefined;
      const status = receiptInfo.last.outcome.status;
      const detail = receiptInfo.last.outcome.detail !== undefined ? `  ${receiptInfo.last.outcome.detail}` : "";
      out(`Last build:      ${ts}  ${status}${detail}\n`);
      if (meta?.verificationResult !== undefined) out(`  Verified:      ${meta.verificationResult}\n`);
      if (receiptInfo.last.requestId !== undefined) out(`  Task:          ${receiptInfo.last.requestId}\n`);
    } else {
      out(`Last build:      (none)\n`);
    }
    out(`\n`);
    out(`Tip: run \`ikbi build "..." --repo ${repoPath}\` to start a build.\n`);
  }

  return { audit };
}

registerCommand({
  name: "audit",
  summary: "Read-only diagnostic snapshot of a repo (type, workspaces, receipts)",
  usage: "ikbi audit <repo>",
  run: (argv) => createAuditCli().audit(argv),
});
