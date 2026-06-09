# Claude Fable 5 — Context for ikbi Auditing & Development

**Generated:** June 9, 2026 (launch day)
**Model:** Anthropic Claude Fable 5 (`claude-fable-5`)
**Tool:** Claude Code (Anthropic's agentic coding CLI)
**Target:** ikbi (`/pehverse/repos/ikbi`)
**Usage:** Fable 5 runs INSIDE Claude Code to audit, fix, and improve ikbi. Fable 5 is NEVER used as a provider inside ikbi itself.

---

## What Fable 5 Is

Claude Fable 5 is Anthropic's most capable **widely released** model, announced today (June 9, 2026). It is the public counterpart to Claude Mythos 5 (invitation-only, Project Glasswing). Key specs:

| Property | Value |
|----------|-------|
| **Context Window** | **1,000,000 tokens (1M)** |
| **Tool/Function Calling** | Yes (native, used by Claude Code) |
| **Vision** | Yes (text + image input) |
| **Adaptive Thinking** | **Always on** — the model thinks before acting |
| **Extended Thinking** | No (adaptive thinking fills this role) |
| **Predecessor** | Claude Opus 4.8 (200K context, $5/$25 MTok) |

---

## What 1M Context Means for Auditing ikbi

Previous audits used MiMo v2.5 (32K context) or DeepSeek v4 (65K context). Fable 5's 1M context is **15-30x larger**. This changes everything:

### You Can Feed the Entire Codebase at Once

| ikbi Component | Size | MiMo 32K | DeepSeek 65K | Fable 5 1M |
|----------------|------|----------|-------------|------------|
| Full builder.ts | ~30K | Barely fits | Fits | Trivial |
| All 4 new modules (index/retrieval/ladder/triage) | ~50K | No | Tight | Trivial |
| Entire src/modules/ | ~200K | No | No | Comfortable |
| Entire src/ (276 files) | ~800K | No | No | Fits |
| Full repo + all docs | ~1.2M | No | No | Too large |

**The sweet spot:** Fable 5 can read and reason about the ENTIRE `src/modules/` directory (all 100+ files) in one context. This means cross-module analysis that was previously impossible — the model can hold the full architecture in its head simultaneously.

### Cross-Module Reasoning Becomes Practical

Previous audits had to focus on one module at a time because the model couldn't hold multiple modules in context. With Fable 5, you can ask:

- "Trace a build from `orchestrator.ts` → `builder.ts` → `verifier.ts` → `integrator.ts` and find inconsistencies in how errors propagate."
- "Compare the injection chokepoint in `builder.ts`, `chat/session.ts`, and `mcp-model-loop/loop.ts` — are all three enforced identically?"
- "Show me every path where `neutralizeUntrusted` is NOT called on tool output before it enters a ModelMessage."

These were impossible before. Fable 5 makes them routine.

### Adaptive Thinking = Deeper Audits

Fable 5's adaptive thinking means it will internally deliberate before responding. For an audit, this means:

- It will notice that line 889 of builder.ts contradicts line 523 of the same file
- It will trace dependency chains through 4+ modules without losing track
- It will identify subtle TOCTOU windows that require holding multiple invariants simultaneously
- It will catch "this check passes but only because condition X was already true from line Y" — chains of reasoning that smaller models miss

**The tradeoff:** Adaptive thinking adds 5-30 seconds of latency before the first token. This is normal. The model is THINKING — let it.

---

## How to Prompt Fable 5 for ikbi Audits (for Zen)

### What Fable 5 Excels At

1. **Deep architecture analysis** — Feed it the full module tree and ask about consistency
2. **Invariant verification** — "Is invariant X enforced at every call site?"
3. **Cross-module trace** — "Show me the full path of a tool result from terminal.ts → builder.ts → the model"
4. **False-green hunting** — "Find every code path where a check could return PASS without actually running"
5. **Scale analysis** — "What happens when maxFiles=200000 and the walk encounters a circular symlink?"

### What Fable 5 Is NOT Good For (relative to its size)

1. **Quick fixes** — The thinking latency makes small edits slower than Sonnet/Haiku
2. **Incremental changes** — Fable 5 is a "big picture" model. Small surgical edits are better on Sonnet
3. **Cost-sensitive work** — Fable 5 is expensive. Reserve it for audits, architecture, and critical fixes

### Prompt Patterns That Work

**BAD:** "Fix the bug in builder.ts" (wastes Fable 5's capacity on a small task)

**GOOD:** "Here is the full source of `src/modules/`. The builder, chat, and MCP loop all have independent tool-result→model-message paths. I need you to verify that ALL THREE enforce injection neutralization identically. Find every divergence. Show me exact line numbers."

**GOOD:** "I have 276 source files in this repo. The architecture document says 'every tool result MUST pass through neutralizeUntrusted.' Search the full codebase for any code path where a tool result string becomes a ModelMessage WITHOUT going through neutralizeUntrusted. This is a security-critical invariant."

---

## ikbi Auditing — Fable 5's Unique Advantages

### 1. Full Pipeline Trace in One Context

Feed Fable 5 the entire scout→builder→critic→verifier→integrator pipeline (all 5 role files + orchestrator). Ask: "Trace a single build from allocation to promotion. Find every point where the system can silently succeed despite the underlying work being wrong."

### 2. Multi-Module Invariant Checking

ikbi has architectural invariants spread across modules:
- "Injection neutralization is mandatory" — enforced in builder.ts, chat/session.ts, mcp-model-loop/loop.ts
- "Governed exec is the only path to a shell command" — enforced in verifier.ts, builder.ts
- "Worktree confinement prevents escape" — enforced in builder-tools/confine.ts

Fable 5 can check ALL enforcement points for a single invariant simultaneously.

### 3. Scale-Stress Testing

Previous audits flagged that ikbi's caps are designed for small repos. With Fable 5's capacity, you can feed it the scale-critical code paths and ask: "What happens at 200,000 files? At 1,000 packages? When maxImpactHops=3 is exceeded? When the racy window is 0?"

### 4. Audit Document Generation

The existing audit docs in `/pehverse/repos/ikbi/docs/` are the ground truth. Fable 5 can read ALL of them simultaneously and produce a consolidated gap analysis that no smaller model could attempt.

---

## Current ikbi Audit Document Inventory (for context)

| Document | Lines | Content |
|----------|-------|---------|
| `IKBI-HOSTILE-AUDIT.md` | 262 | 7 blockers, 5 false-green risks, 5 scale risks, 5 trust risks |
| `IKBI-FRESH-AUDIT-EXPERIENCE-GAPS.md` | 248 | 14 experience gaps vs Claude Code |
| `IKBI-VS-CLAUDE-CODE-COMPARISON.md` | 175 | Feature matrix, tool parity |
| `IKBI-GAP-FIX-VERIFICATION.md` | 198 | Verification of Julian's CC session fixes |
| `TRIO-AUDIT-PEHLICHI-LUNA-PTAH.md` | 332 | Pehlichi/Luna/Ptah core identity + Hermes comparison |
| `HERMES-BUILD-STATE.md` | ~80 | Build phase tracker |
| `ikbi-context.md` | ~140 | Architecture orientation for builders |
| `ikbi-module-plan.md` | ~380 | Module dependency graph + build order |

**Fable 5 can read ALL of these in a single context window** (total ~1,800 lines ≈ 150K tokens). Previous models could read 1-2 documents at most.

---

## ikbi Source Code Size Reference

| Scope | Files | Approx Tokens | Fable 5 Capacity |
|-------|-------|---------------|-----------------|
| Single module (e.g., builder.ts) | 1 | ~15K | 1.5% of window |
| Worker-model (all roles) | 12 | ~100K | 10% |
| All src/modules/ | ~110 | ~400K | 40% |
| Entire src/ | 276 | ~800K | 80% |
| Full repo | 276 + docs | ~1.2M | Exceeds window — selective loading needed |

**Recommendation for audits:** Feed Fable 5 the full `src/modules/` tree (~40% of window) plus the relevant audit docs. This gives enough headroom for the model's response and tool output while still covering the entire module surface.

---

## Key Facts for Future Auditors

1. **Fable 5 has 1M context.** Use it. Ask it to read entire directories, not individual files.
2. **Fable 5 thinks before responding.** The 5-30s latency is adaptive thinking, not a hang.
3. **Fable 5 is expensive.** Reserve for architecture audits and critical path analysis. Use Sonnet for quick fixes.
4. **Fable 5 is NOT running inside ikbi.** ikbi still uses MiMo/DeepSeek. Fable 5 is the AUDITOR, not the engine.
5. **The hostile audit blockers are FIXED.** Verified at commit `c8cfc00`. 1037 tests passing. Focus on NEW findings.
6. **The existing audit docs are the ground truth.** Read them all (they fit in context). Don't re-discover known findings.

---

*Context document for Claude Code + Fable 5 operating on the ikbi codebase.*
*Updated: June 9, 2026 — Fable 5 launch day.*
