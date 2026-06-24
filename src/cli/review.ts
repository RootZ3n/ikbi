/**
 * ikbi `review [path...]` — structured, CONSTRUCTIVE code review.
 *
 * The friendly counterpart to `audit`: instead of an adversarial multi-model scout flagging
 * hypotheses, this asks ONE model for a balanced review — an overall summary plus file-by-file
 * comments with severity ratings, covering code quality, bugs, performance, readability, and test
 * coverage. Output is Markdown by default, or `--json` for tooling.
 *
 * Scope resolution:
 *   - `ikbi review`                 → the working tree's current changes (git diff vs HEAD + untracked)
 *   - `ikbi review src/foo.ts ...`  → the named files
 *   - `ikbi review --pr 123`        → the changed files of GitHub PR #123 (via `gh`)
 *   - `ikbi review --all`           → a bounded walk of the whole repo
 *
 * READ-ONLY: it never writes to the repo. It reuses the audit file-reader + the review engine.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { whatNextFooter } from "./what-next.js";
import { config } from "../core/config.js";
import { gatherFiles } from "../modules/worker-model/scout-files.js";
import { formatReviewMarkdown, runReview, type ReviewOptions, type ReviewResult } from "../modules/worker-model/review.js";

/** A resolved review scope: the files to review (absolute) + an optional focusing diff. */
interface ReviewScope {
  readonly files: readonly string[];
  readonly diff?: string;
  /** Human label for the scope (printed in non-JSON mode). */
  readonly label: string;
}

/** Injectable surfaces (all default to the real implementations) — for tests. */
export interface ReviewCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Resolve the working tree's changed files + diff (default: git). */
  readonly localChanges?: (repo: string) => { files: string[]; diff: string };
  /** Resolve a PR's changed files + diff (default: gh). */
  readonly prChanges?: (repo: string, pr: number) => { files: string[]; diff: string };
  /** The review engine (default: runReview). */
  readonly runReview?: (opts: ReviewOptions) => Promise<ReviewResult>;
  /** Default model id (default: the configured critic model). */
  readonly model?: string;
}

interface ReviewArgs {
  readonly repo: string;
  readonly paths: string[];
  readonly pr?: number;
  readonly all: boolean;
  readonly json: boolean;
  readonly model?: string;
  readonly help: boolean;
}

const USAGE = "ikbi review [path...] [--pr <n>] [--all] [--repo <dir>] [--model <id>] [--json]";

export function parseReviewArgs(argv: readonly string[]): ReviewArgs {
  let repo = process.cwd();
  const paths: string[] = [];
  let pr: number | undefined;
  let all = false;
  let json = false;
  let model: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (a === "--pr") { const n = Number(argv[i + 1]); if (Number.isInteger(n) && n > 0) pr = n; i += 1; }
    else if (a === "--repo") { if (argv[i + 1] !== undefined) repo = argv[i + 1] as string; i += 1; }
    else if (a === "--model") { if (argv[i + 1] !== undefined) model = argv[i + 1] as string; i += 1; }
    else if (!a.startsWith("-")) paths.push(a);
  }
  return { repo, paths, ...(pr !== undefined ? { pr } : {}), all, json, ...(model !== undefined ? { model } : {}), help };
}

/** Default working-tree change resolver: git diff vs HEAD + untracked files. */
function defaultLocalChanges(repo: string): { files: string[]; diff: string } {
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const tracked = git(["diff", "--name-only", "HEAD"]).split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const files = [...new Set([...tracked, ...untracked])];
  const diff = git(["diff", "HEAD"]);
  return { files, diff };
}

/** Default PR change resolver via the GitHub CLI (`gh`). */
function defaultPrChanges(repo: string, pr: number): { files: string[]; diff: string } {
  const gh = (args: string[]): string =>
    execFileSync("gh", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const files = gh(["pr", "diff", String(pr), "--name-only"]).split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const diff = gh(["pr", "diff", String(pr)]);
  return { files, diff };
}

/** Turn repo-relative paths into existing absolute file paths (drops directories/missing). */
function toAbsoluteFiles(repo: string, rels: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    const abs = isAbsolute(rel) ? rel : join(repo, rel);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) out.push(abs);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export function createReviewCli(deps: ReviewCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const localChanges = deps.localChanges ?? defaultLocalChanges;
  const prChanges = deps.prChanges ?? defaultPrChanges;
  const review = deps.runReview ?? runReview;
  const defaultModel = deps.model ?? config.provider.defaultModels.critic;

  async function run(argv: readonly string[]): Promise<void> {
    const args = parseReviewArgs(argv);
    if (args.help) {
      out(`Usage: ${USAGE}\n\nReview the current changes, specific files, or a PR. Constructive, structured output.\n`);
      return;
    }
    if (!existsSync(args.repo)) {
      err(`review: repo not found: ${args.repo}\n`);
      setExit(1);
      return;
    }

    // Resolve the scope → files (absolute) + optional diff.
    let scope: ReviewScope;
    try {
      scope = resolveScope(args, { repo: args.repo, localChanges, prChanges });
    } catch (e) {
      err(`review: could not resolve scope: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }
    if (scope.files.length === 0) {
      err(`review: no files to review (${scope.label}). Pass file paths, use --all, or make some changes.\n`);
      setExit(1);
      return;
    }

    const model = args.model ?? defaultModel;
    let result: ReviewResult;
    try {
      result = await review({
        repoPath: args.repo,
        files: scope.files,
        model,
        ...(scope.diff !== undefined && scope.diff.length > 0 ? { diff: scope.diff } : {}),
      });
    } catch (e) {
      err(`review: failed: ${e instanceof Error ? e.message : String(e)}\n`);
      setExit(1);
      return;
    }

    if (args.json) {
      out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      out(`${formatReviewMarkdown(result)}\n`);
      out(`${whatNextFooter("review", { issues: result.comments.length })}\n`);
    }
    // A model failure that produced no review is a non-zero exit (so CI can gate on it).
    if (result.error !== undefined && result.comments.length === 0) setExit(1);
  }

  return { run };
}

/** Resolve the review scope from the parsed args. Throws only on a hard resolver failure (e.g. gh). */
export function resolveScope(
  args: ReviewArgs,
  deps: { repo: string; localChanges: (repo: string) => { files: string[]; diff: string }; prChanges: (repo: string, pr: number) => { files: string[]; diff: string } },
): ReviewScope {
  // Explicit file paths win.
  if (args.paths.length > 0) {
    return { files: toAbsoluteFiles(deps.repo, args.paths), label: `${args.paths.length} path(s)` };
  }
  // Whole-repo review.
  if (args.all) {
    return { files: gatherFiles(deps.repo), label: "whole repo" };
  }
  // A specific PR.
  if (args.pr !== undefined) {
    const { files, diff } = deps.prChanges(deps.repo, args.pr);
    return { files: toAbsoluteFiles(deps.repo, files), diff, label: `PR #${args.pr}` };
  }
  // Default: the working tree's current changes.
  const { files, diff } = deps.localChanges(deps.repo);
  return { files: toAbsoluteFiles(deps.repo, files), diff, label: "current changes" };
}

registerCommand({
  name: "review",
  summary: "Constructive structured code review (current changes, files, or a PR) — markdown or --json",
  usage: USAGE,
  run: (argv) => createReviewCli().run(argv),
});
