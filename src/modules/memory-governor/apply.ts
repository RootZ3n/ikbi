/**
 * ikbi memory-governor — PRODUCTION APPLY FUNCTIONS.
 *
 * When a proposal is APPROVED, the apply function writes the proposed content
 * to the actual target surface (file or brain page). This module provides the
 * real apply functions for production use.
 *
 * Two surface types:
 *   - File surfaces (CLAUDE.md, .ikbi/*, etc.): write content to the absolute path
 *   - Brain surfaces (brain pages): call gbrainBridge.putPage(slug, content)
 *
 * The governor is constructed once and shared across proposals. The apply function
 * receives the full proposal at approve-time, so it can dispatch by surface type.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryProposal } from "./contract.js";
import type { GbrainBridge } from "../../core/gbrain-bridge.js";

/**
 * Apply function for FILE surfaces. Writes `proposal.content` to `proposal.target`
 * (which must be an absolute path by the time a proposal is approved).
 *
 * Creates parent directories if needed. Throws on write failure.
 */
export async function applyFileProposal(proposal: MemoryProposal): Promise<void> {
  const target = proposal.target;
  // The target should be absolute (resolved at proposal-creation time by the
  // shared tool-executor). If it's relative, the apply fails loudly — the caller
  // should have resolved it.
  if (!target.startsWith("/")) {
    throw new Error(`memory-governor apply: file target "${target}" is not absolute — cannot apply safely`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, proposal.content, "utf8");
}

/**
 * Apply function for BRAIN surfaces. Calls gbrainBridge.putPage(slug, content).
 *
 * The `target` field holds the brain slug. Throws on gbrain failure.
 */
export function createBrainApply(bridge: GbrainBridge) {
  return async function applyBrainProposal(proposal: MemoryProposal): Promise<void> {
    const slug = proposal.target;
    if (slug.length === 0) {
      throw new Error("memory-governor apply: brain target (slug) is empty");
    }
    bridge.putPage(slug, proposal.content);
  };
}

/**
 * Combined apply function — dispatches by surface type.
 *
 * - `brain_page` → uses the gbrain bridge (if wired; skips silently if not)
 * - `project_file` / `instruction_file` → writes to the absolute file path
 *
 * This is the function to pass to `createMemoryGovernor({ apply })` in production.
 */
export function createCombinedApply(bridge?: GbrainBridge) {
  return async function applyProposal(proposal: MemoryProposal): Promise<void> {
    switch (proposal.surface) {
      case "brain_page":
        if (bridge === undefined) {
          // No gbrain bridge — skip silently. The proposal stays "approved" in the
          // store but the brain page is not written. The operator can re-apply later.
          return;
        }
        return createBrainApply(bridge)(proposal);
      case "project_file":
      case "instruction_file":
        return applyFileProposal(proposal);
      default:
        throw new Error(`memory-governor apply: unknown surface "${(proposal as MemoryProposal).surface}"`);
    }
  };
}
