/**
 * ikbi job-cards — 8 built-in job card definitions.
 *
 * These are the default cards available out of the box. Each is a reusable,
 * bounded automation with explicit guardrails.
 */

import type { JobCard } from "./contract.js";

/** Create a built-in card (id is deterministic from slug). */
function builtin(slug: string, fields: Omit<JobCard, "id" | "createdAt" | "updatedAt">): JobCard {
  const now = new Date(0).toISOString(); // deterministic for builtins
  return { ...fields, id: `builtin-${slug}`, createdAt: now, updatedAt: now };
}

/** The 8 built-in job cards. */
export const BUILTINS: readonly JobCard[] = [
  builtin("repo-gardener", {
    name: "Repo Gardener",
    description: "Find god files, stale docs, unused exports, and suggest bounded refactors.",
    goalTemplate: "Analyze the repository structure. Find god files (>500 lines), stale documentation, unused exports. For each finding, suggest a bounded refactor with blast radius analysis.",
    accessPolicy: "write-gated",
    guardrails: { maxFilesChanged: 10, protectedPaths: [".env", ".env.*", "package-lock.json"], requireCleanWorktree: true },
    verification: "required",
    rollback: "on-failure",
    schedule: "once",
    minTrustTier: "earned",
  }),
  builtin("receipt-doctor", {
    name: "Receipt Doctor",
    description: "Audit receipts for gaps — missing verification, incomplete metadata, orphaned entries.",
    goalTemplate: "Audit all receipts in the system. Check for: missing verification status, incomplete metadata, orphaned entries with no matching task, and receipts older than 30 days with no resolution.",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
  }),
  builtin("dependency-mapper", {
    name: "Dependency Mapper",
    description: "Map the dependency graph, find circular dependencies and unused packages.",
    goalTemplate: "Map the full dependency graph of the project. Identify circular dependencies, unused packages, and packages that are imported but not declared in package.json.",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
  }),
  builtin("docs-drift-auditor", {
    name: "Docs Drift Auditor",
    description: "Compare documentation to actual code — find stale READMEs, missing JSDoc, outdated examples.",
    goalTemplate: "Compare all documentation files to the actual codebase. Find: stale READMEs that reference removed features, missing JSDoc on exported functions, outdated code examples, and broken documentation links.",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
  }),
  builtin("test-gap-finder", {
    name: "Test Gap Finder",
    description: "Find untested code paths — modules without matching test files.",
    goalTemplate: "Scan all source modules and identify files that lack matching test files (.test.ts). Report coverage gaps with file paths and suggested test scenarios.",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
  }),
  builtin("security-sweep", {
    name: "Security Sweep",
    description: "Scan for hardcoded secrets, unsafe patterns, and injection vulnerabilities.",
    goalTemplate: "Perform a security sweep of the codebase. Look for: hardcoded secrets/API keys, unsafe eval/exec patterns, SQL injection risks, path traversal vulnerabilities, and exposed sensitive endpoints.",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
  }),
  builtin("refactor-planner", {
    name: "Refactor Planner",
    description: "Suggest bounded refactors with blast radius analysis and risk assessment.",
    goalTemplate: "Analyze the codebase for refactoring opportunities. For each suggestion, provide: the target files, the refactoring type (extract, rename, move, inline), blast radius (files affected), and risk level.",
    accessPolicy: "read-only",
    guardrails: { maxFilesChanged: 0, protectedPaths: [], requireCleanWorktree: false },
    verification: "skip",
    rollback: "never",
    schedule: "once",
    minTrustTier: "provisional",
  }),
  builtin("import-cleaner", {
    name: "Import Cleaner",
    description: "Remove unused imports — max 5 files per run to keep changes bounded.",
    goalTemplate: "Find and remove unused imports across the codebase. Limit changes to a maximum of 5 files per run. Verify each removal does not break the module's functionality.",
    accessPolicy: "write-gated",
    guardrails: { maxFilesChanged: 5, protectedPaths: [".env", ".env.*"], requireCleanWorktree: true },
    verification: "required",
    rollback: "on-failure",
    schedule: "once",
    minTrustTier: "earned",
  }),
];

/** Get a built-in card by id. */
export function getBuiltin(id: string): JobCard | undefined {
  return BUILTINS.find((c) => c.id === id);
}
