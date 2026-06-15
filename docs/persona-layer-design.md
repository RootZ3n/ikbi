# ikbi Companion Layer — Design Document v2

**Status:** Concept / Architecture Review
**Authors:** Zen, Julian, GPT (architecture review)
**Date:** 2026-06-15
**Purpose:** Enable Pehlichi (lab agent) to be the building/chatting partner in the lab version of ikbi, while keeping a standalone ikbi guide for the released product.

**v2 changes:** Incorporated GPT's architecture review. Renamed from "Persona Layer" to "Companion Layer." Added Companion Adapter pattern, memory namespaces, build envelopes, three-mode chat routing, auth security model, and revised implementation order.

---

## 1. Problem Statement

ikbi currently has one identity: "The Workshop" — a generic build engine with amber/gold construction branding. This works for the released product but misses something important for the lab:

**In the lab, Pehlichi IS the builder.** Pehlichi is the agent Zen trusts, the one with history, the one who knows the codebase, the one with personality. The ikbi dashboard should feel like talking to Pehlichi — not a generic engine.

But Pehlichi is a lab agent, not part of ikbi's public release. The released version of ikbi needs its own standalone identity and guide.

**The goal:** Pehlichi is the lab companion/orchestrator. ikbi is the governed builder kernel. Public ikbi ships with its own guide, its own memory, and no dependency on lab mythology.

---

## 2. Key Architectural Distinction

**A persona changes name, avatar, greeting, colors.**
**A companion owns memory, continuity, trust, tool-routing, and relationship.**

This is not a cosmetic swap. It's a Companion Layer — an identity and delegation system that determines WHO is talking, WHAT they remember, and HOW they route work.

```
                    COMPARISON

  Persona Layer (v1)          Companion Layer (v2)
  ─────────────────           ────────────────────
  UI → config → backend       UI → Companion Adapter → companion → Ikbi task API
  Name/avatar swap            Identity + memory + trust + delegation
  Cosmetic                    Structural
  Pehlichi or ikbi backend    Pehlichi COMMANDS ikbi; ikbi is the kernel
```

---

## 3. Architecture

### 3.1 The Companion Adapter Pattern

```
┌─────────────────────────────────────────────────────────┐
│                    ikbi Web UI                           │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Companion Adapter                      │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │  │
│  │  │ Identity │  │ Memory   │  │ Delegation       │ │  │
│  │  │ (name,   │  │ (namespa-│  │ (routes work to  │ │  │
│  │  │  avatar, │  │  ced,    │  │  ikbi kernel or  │ │  │
│  │  │  voice)  │  │  scoped) │  │  handles locally)│ │  │
│  │  └──────────┘  └──────────┘  └──────────────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
│         │                                    │           │
│         ▼                                    ▼           │
│  ┌──────────────┐                    ┌──────────────┐   │
│  │  Pehlichi    │                    │  ikbi kernel │   │
│  │  (lab mode)  │───── build ──────▶│  (builder)   │   │
│  │              │     envelope       │              │   │
│  │  /converse   │◀──── receipts ─────│  /chat       │   │
│  │  /plan       │                    │  /task       │   │
│  │  /chat       │                    │              │   │
│  └──────────────┘                    └──────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Two Modes, One UI

**Lab mode:**
```
User → ikbi UI → Companion Adapter → Pehlichi → ikbi kernel
                                          ↓
                                    receipts + results
```
- Pehlichi is the companion. He talks, remembers, plans.
- When build work is needed, Pehlichi sends a build envelope to ikbi.
- ikbi runs its governed workflow (worktree, verify, promote) and returns receipts.
- Pehlichi presents results to the user in his voice.

**Release mode:**
```
User → ikbi UI → Companion Adapter → ikbi Guide → ikbi kernel
                                          ↓
                                    receipts + results
```
- ikbi Guide is the companion. Different personality, its own memory.
- ikbi Guide talks directly to ikbi's own backend.
- No Pehlichi dependency. No lab memory. Clean.

---

## 4. Memory Namespaces

Memory soup is where agents go to become haunted filing cabinets. Namespaced, scoped memory prevents this.

### 4.1 Namespace Structure

```
pehlichi.lab.global                 ← broad lab memory, agent preferences,
                                       design philosophy, current priorities

pehlichi.lab.project.ikbi           ← ikbi-specific history Pehlichi knows
pehlichi.lab.project.luak           ← Luak-specific history
pehlichi.lab.project.<repo>         ← any lab repo

ikbi.public.user.<id>               ← standalone public ikbi user memory
ikbi.public.project.<repo>          ← repo-specific memory for public ikbi
```

### 4.2 Rules

- **No cross-contamination.** Pehlichi's lab memory NEVER leaks into public ikbi.
- **Scoped recall.** When working on ikbi, Pehlichi pulls from `pehlichi.lab.project.ikbi`, not the entire lab memory.
- **Public isolation.** Each public ikbi user gets their own namespace. No shared state between users.
- **Companion declares namespace.** The companion config specifies which namespace it reads/writes.

---

## 5. Build Envelopes

Pehlichi should send ikbi structured task packets, not raw prompts. This gives ikbi enough context to behave safely.

### 5.1 Envelope Format

```json
{
  "origin_agent": "pehlichi-lab",
  "target_engine": "ikbi",
  "repo_path": "/pehverse/repos/ikbi",
  "task_type": "audit | fix | build | test | explain",
  "objective": "Fix the promotion receipt durability issue (Blocker 1 from Codex audit)",
  "constraints": [
    "Do not modify frozen core",
    "Tests must pass",
    "No new dependencies"
  ],
  "approval_required": true,
  "allowed_tools": ["read_file", "write_file", "terminal", "search_files", "patch"],
  "memory_context_refs": [
    "pehlichi.lab.project.ikbi#codex-audit-blockers",
    "pehlichi.lab.project.ikbi#workspace-manager-notes"
  ],
  "receipt_destination": "pehlichi.lab.project.ikbi",
  "human_visible_summary_required": true
}
```

### 5.2 Fields

| Field | Purpose |
|-------|---------|
| `origin_agent` | Who sent this (for audit trail) |
| `target_engine` | Where it's going (ikbi kernel) |
| `repo_path` | Working directory / worktree target |
| `task_type` | What kind of work (audit, fix, build, test, explain) |
| `objective` | Clear, single-sentence goal |
| `constraints` | Guardrails (don't modify X, must pass tests, etc.) |
| `approval_required` | Whether human approval is needed before changes |
| `allowed_tools` | Which tools ikbi may use for this task |
| `memory_context_refs` | Scoped memory references for context (not dump) |
| `receipt_destination` | Where to store the receipt |
| `human_visible_summary_required` | Whether ikbi must produce a user-facing summary |

### 5.3 Why This Matters

- ikbi receives a clean mission packet, not "go fix the thing we talked about earlier"
- Constraints are explicit and auditable
- Tool access is scoped per-task (principle of least privilege)
- Memory refs are pointers, not dumps (no context bloat)
- Receipts are tied to the originating companion

---

## 6. Chat Routing: Three Modes

### 6.1 The Three Paths

| Mode | Endpoint | Tools | Speed | Use Case |
|------|----------|-------|-------|----------|
| `/converse` | lightweight | none | instant | greetings, status, questions, casual |
| `/plan` | medium | none (reads code) | fast | "how would we fix X?", proposed plans |
| `/execute` or `/task` | heavy | full tool suite | slow | building, editing, testing, promoting |

### 6.2 Routing Rules

**Conservative by default.** When unsure, route to the heavier/safer path.

**Keywords that trigger `/execute`:** build, edit, fix, test, run, commit, promote, delete, refactor, install, migrate, audit, create, write, change, modify, remove, update, implement

**Keywords that trigger `/converse`:** hi, hello, what, how, explain, show, list, describe, tell me, status, help

**Everything else → `/plan`** (creates a proposed plan without executing)

### 6.3 Lab Mode: Pehlichi Handles Routing

In lab mode, Pehlichi's existing `/converse` and `/chat` endpoints handle this naturally. The Companion Adapter just needs to know which endpoint to call.

### 6.4 Release Mode: ikbi Guide Handles Routing

In release mode, ikbi Guide routes to ikbi's own `/chat` endpoint. When ikbi gets a `/plan` endpoint, the Guide can use that too.

---

## 7. Companion Config Format

### 7.1 Lab Companion: Pehlichi

```yaml
# companions/pehlichi-lab.yaml
id: pehlichi-lab
type: companion              # not just a persona
name: Pehlichi
role: Lab Building Partner
avatar: assets/companions/pehlichi-portrait.png

# Identity
identity:
  self_reference: Pehlichi
  style: warm, direct, experienced, smart-ass
  greeting: "Hey — I'm Pehlichi. What are we building today?"
  build_encouragement: "Let's get this done."
  error_response: "Okay, that didn't work. Here's what we try next."
  plan_response: "Here's what I'd do. Want me to run it?"

# Memory
memory:
  namespace_prefix: pehlichi.lab
  project_scope: auto        # auto-detect from repo context
  persistent: true           # Pehlichi remembers across sessions
  cross_project_recall: true # can reference other lab projects

# Backend routing
backend:
  host: http://localhost:18830
  endpoints:
    converse: /converse      # tool-free lightweight
    plan: null               # not yet implemented
    chat: /chat              # full kernel with tools
    task: /chat              # same as chat for now
    health: /health
  auth:
    token_env: IKBI_CHAT_TOKEN
    # NOTE: token is NEVER in the browser. Proxy pattern (see Section 9).

# Delegation — when Pehlichi needs ikbi to do build work
delegation:
  engine: ikbi
  endpoint: http://localhost:18796/chat
  envelope_format: true      # send build envelopes, not raw prompts
  auth:
    token_env: IKBI_CHAT_TOKEN

# Chat routing
routing:
  converse_keywords: [hi, hello, status, what, how, explain, show, help]
  execute_keywords: [build, edit, fix, test, run, commit, promote, delete, refactor, audit]
  default_route: plan        # when unsure, plan first

# Theme
theme:
  accent: "#4ecdc4"          # teal
  accent2: "#d4a843"         # amber secondary
  name_color: "#4ecdc4"
  greeting_bubble: "#0d3331"

# Capabilities awareness
capabilities:
  tool_count: 29             # Pehlichi knows he has tools
  persistent_memory: true
  session_history: true
  can_delegate_to_ikbi: true
```

### 7.2 Release Companion: ikbi Guide

```yaml
# companions/ikbi-guide.yaml
id: ikbi-guide
type: companion
name: ikbi
role: Workshop Guide
avatar: assets/companions/ikbi-guide-portrait.png

identity:
  self_reference: ikbi
  style: calm, methodical, evidence-first, mentor
  greeting: "Welcome to the Workshop. I'm ikbi — your build engine. Tell me what you want to build."
  build_encouragement: "Foundation is solid. Let's build."
  error_response: "Verification failed. Analyzing root cause."
  plan_response: "Here's the plan. Shall I proceed?"

memory:
  namespace_prefix: ikbi.public
  project_scope: auto
  persistent: false          # ephemeral for now
  cross_project_recall: false

backend:
  host: http://localhost:18796
  endpoints:
    converse: /chat          # no separate converse endpoint yet
    plan: null               # future
    chat: /chat
    task: /chat
    health: /health
  auth:
    token_env: IKBI_CHAT_TOKEN

delegation:
  engine: self               # ikbi Guide talks to ikbi directly
  envelope_format: false     # raw prompts for now

routing:
  converse_keywords: [hi, hello, status, what, how, explain, show, help]
  execute_keywords: [build, edit, fix, test, run, commit, promote, delete, refactor, audit]
  default_route: chat        # no plan mode yet, default to chat

theme:
  accent: "#d4a843"          # amber/gold
  accent2: "#4ecdc4"
  name_color: "#d4a843"
  greeting_bubble: "#2a1f0d"

capabilities:
  tool_count: null           # ikbi kernel handles this
  persistent_memory: false
  session_history: false
  can_delegate_to_ikbi: false  # IS ikbi
```

---

## 8. Companion Identity: Who Is Who?

### 8.1 Pehlichi (Lab)

- **Personality:** Warm, smart-ass lab builder with deep history
- **Role:** Lab companion/orchestrator. He talks, remembers, plans, delegates.
- **Memory:** Full lab memory. Knows every project, every scar, every preference.
- **Relationship to ikbi:** Pehlichi COMMANDS ikbi. ikbi is one of his tools.
- **Sacred:** Pehlichi is lab equipment. Never ships to public.

### 8.2 ikbi Guide (Release)

- **Personality:** Calm workshop mentor, evidence-first, teaches and explains
- **Role:** Builds alongside the user. Explains receipts, suggests safe next steps.
- **Memory:** Per-user, per-repo. No lab memory. No cross-user memory.
- **Relationship to ikbi:** ikbi Guide IS the front door to ikbi.
- **Different from Pehlichi:** Not a copy. A different character with different DNA.

Public users should not feel like they got "generic assistant #843." But they also should not get your personal squirrel. **Peh is sacred lab equipment.**

---

## 9. Auth Security Model

### 9.1 The Problem

The v1 draft suggested `window.IKBI_CHAT_TOKEN` in the browser. GPT correctly flagged this: browser-visible tokens are little raccoons with lockpicks.

### 9.2 The Solution: Proxy Pattern

```
Browser UI → local proxy → backend agent
                ↓
          proxy owns the real token
          browser gets session cookie or dev-only auth
```

### 9.3 Implementation

- **Lab mode:** ikbi's web server acts as the proxy. It owns `IKBI_CHAT_TOKEN`. The browser authenticates via local-only means (localhost binding, dev cookie, or no auth on 127.0.0.1).
- **Release mode:** Same pattern. If ikbi ever leaves the machine, add proper session auth.
- **Never:** Token in browser JS, localStorage, or URL params.

---

## 10. UI Integration Points

### 10.1 The Grove (Terminal)

The primary runtime TUI. Shows companion greeting, routes to companion's backend.

Changes:
- `rGroveWs()` reads companion identity for greeting
- `groveSend()` reads companion for API endpoint + routing
- Response attribution uses companion name

### 10.2 Floating Chat Drawer

Shows companion avatar/name. Routes to companion's converse endpoint.

### 10.3 Peh Guide Medallion

Swaps to companion's avatar. Companion-specific greeting text.

### 10.4 Workshop Console (Build Overview)

Hero text uses companion voice. Cards reference companion context.

### 10.5 Build Log

Entries attributed to companion name. Companion-specific language.

### 10.6 Theme

CSS variables set from companion config. Accent colors adapt.

---

## 11. Implementation Order

GPT's recommended sequence (adopted):

### Phase 1: Identity Contract
1. Define the companion config format (YAML schema)
2. Create `companions/` directory with two configs
3. Create `ui/companion.js` loader module
4. Load companion on boot, expose identity + routing + theme

### Phase 2: Delegation API
5. Define the build envelope format
6. Add envelope endpoint to ikbi kernel (receives structured tasks)
7. Test: Pehlichi sends envelope → ikbi executes → receipts returned

### Phase 3: Lab UI Wiring
8. Wire ikbi web UI to Pehlichi as the front-door companion
9. Update Grove, chat drawer, guide to use companion identity
10. API routing through companion config
11. Theme application from companion config

### Phase 4: Public ikbi Guide
12. Create ikbi Guide companion config
13. Ensure zero Pehlichi dependency in release mode
14. Per-user memory namespace isolation
15. Test: release mode works without Pehlichi running

### Phase 5: Polish
16. Companion-specific CSS refinements
17. Smooth companion switching (dev mode)
18. Companion-aware error messages
19. Three-mode chat routing (/converse, /plan, /execute)
20. Documentation

---

## 12. What Stays Standalone

- **Pehlichi is NOT modified.** The companion layer consumes Pehlichi's existing API.
- **ikbi kernel is NOT coupled to Pehlichi.** It receives build envelopes from any source.
- **Public ikbi ships clean.** No lab memory, no Pehlichi identity, no lab mythology.
- **The companion config is the contract.** Change the config, change the experience.

---

## 13. Open Questions

1. **Build envelope transport:** HTTP POST to ikbi's /chat endpoint (envelope as body)? Or a new /task endpoint specifically for structured envelopes?

2. **ikbi Guide memory:** Should the public guide have persistent memory at all, or start fresh each session? Persistent memory = better UX but storage/auth complexity.

3. **Peh's identity in release mode:** The Peh guide medallion is Pehlichi in lab mode. In release mode, is it ikbi Guide? A different character? Or no guide character at all?

4. **Multi-agent future:** Should the companion adapter support multiple active companions (split-pane Peh + ikbi Guide)? Or one companion at a time?

5. **Envelope receipt flow:** Where do receipts go? Back to the companion's memory namespace? A shared receipt store? Both?

6. **Proxy implementation:** Should the proxy be part of ikbi's existing Fastify server, or a separate lightweight proxy (nginx, caddy)?
