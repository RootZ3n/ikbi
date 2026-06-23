# Build Plan: Lab Truth Firewall for 6-Agent Hallucination Detection

## Objective

Design and implement a lab-wide hallucination detection and claim verification system for the 6-agent ecosystem.

The goal is not to "stop" agents from hallucinating. The goal is to prevent hallucinated, unsupported, stale, or overbroad claims from entering the lab as accepted truth.

Every important agent claim must become:

```
CLAIM → EVIDENCE → VALIDATION → VERDICT → LOG / GATE
```

No agent should be allowed to directly declare a task "done" without evidence-backed verification.

---

## Core Principle

Agents may make claims.

The system decides whether those claims are accepted.

Final agent reports should no longer be treated as truth by default. They should be treated as claim bundles that must pass through the Truth Firewall.

Golden rule:

```
No claim becomes lab truth until evidence binds it.
```

---

## High-Level Architecture

Implement the system as a reusable lab module/service:

```
Agent Output
   ↓
Claim Extractor
   ↓
Claim Classifier
   ↓
Evidence Resolver
   ↓
Deterministic Validators
   ↓
6-Agent Verification Router
   ↓
Truth Gate
   ↓
Hallucination Log / Reliability Scorecard / Memory Proposal Gate
```

Recommended location:

```
ikbi/src/truth/
```

Do not hardcode agent names. The 6 agents should be configured through an agent registry.

---

## Required Components

### 1. Agent Registry

Create a configurable registry for all 6 agents.

Example:

```json
{
  "agents": [
    {
      "id": "agent_1",
      "name": "Primary Builder",
      "role": "builder",
      "model": "configurable",
      "strengths": ["implementation", "repo edits"],
      "risk_flags": ["overbroad_completion_claims"]
    },
    {
      "id": "agent_2",
      "name": "Verifier",
      "role": "verifier",
      "model": "configurable",
      "strengths": ["tests", "commands", "filesystem checks"],
      "risk_flags": []
    },
    {
      "id": "agent_3",
      "name": "Scope Auditor",
      "role": "scope_auditor",
      "model": "configurable",
      "strengths": ["diff review", "task-vs-output matching"],
      "risk_flags": []
    },
    {
      "id": "agent_4",
      "name": "Skeptic",
      "role": "red_team",
      "model": "configurable",
      "strengths": ["finding unsupported claims", "edge cases"],
      "risk_flags": []
    },
    {
      "id": "agent_5",
      "name": "Integration Reviewer",
      "role": "integration_reviewer",
      "model": "configurable",
      "strengths": ["architecture", "cross-repo impact"],
      "risk_flags": []
    },
    {
      "id": "agent_6",
      "name": "Memory Truth Curator",
      "role": "memory_curator",
      "model": "configurable",
      "strengths": ["memory proposal review", "long-term fact validation"],
      "risk_flags": []
    }
  ]
}
```

---

## 6-Agent Role Design

### Agent 1: Primary Builder

Responsible for doing the actual work.

Allowed to produce:

```
attempted_changes
claim_bundle
evidence_references
known_unverified_items
```

Not allowed to produce:

```
final accepted verdict
memory updates
release readiness declaration
```

### Agent 2: Verifier

Runs deterministic validation.

Responsibilities:

```
file exists checks
git diff checks
test commands
build commands
type checks
service health checks
port checks
config checks
commit checks
branch checks
```

### Agent 3: Scope Auditor

Checks whether the claimed scope matches the actual work.

Example detections:

```
Agent claimed "fixed Pehlichi UI" but only changed one helper file.
Agent claimed "all tests pass" but only ran one package test.
Agent claimed "repo cleaned" but ignored untracked files.
Agent claimed "implemented feature" but only added docs.
```

### Agent 4: Skeptic / Red Team

Reviews the claim bundle and receipts for weak spots.

Looks for:

```
unsupported claims
missing evidence
wrong assumptions
ambiguous language
claims that sound broader than the receipts
claims based only on agent memory
claims based on stale docs
```

### Agent 5: Integration Reviewer

Checks whether verified changes fit the wider lab.

Responsibilities:

```
cross-repo impact
service registry alignment
port conflicts
agent bridge compatibility
shared memory implications
naming drift
config drift
UI/API contract drift
```

### Agent 6: Memory Truth Curator

Guards long-term memory and project facts.

No agent should directly write durable lab memory from a normal task result.

Memory proposal verdicts:

```
ACCEPT
REJECT
QUARANTINE
NEEDS_MORE_EVIDENCE
EXPIRES_REQUIRED
```

---

## Claim Verdicts

Every claim must receive exactly one verdict:

```
VERIFIED
CONTRADICTED
UNSUPPORTED
STALE
PARTIAL
UNVERIFIABLE
```

---

## Claim Types (v1)

```
file_exists
file_modified
file_contains
test_result
build_result
typecheck_result
command_result
service_health
port_status
config_value
commit_created
branch_status
git_status
dependency_installed
api_endpoint
memory_fact
architecture_claim
completion_claim
```

High-risk claim types:

```
completion_claim
test_result
build_result
service_health
memory_fact
commit_created
deployment_claim
release_readiness
```

---

## Claim Bundle Schema

```json
{
  "bundle_id": "bundle_20260623_001",
  "task_id": "task_abc123",
  "agent_id": "agent_1",
  "repo": "pehlichi",
  "branch": "feature/truth-firewall",
  "created_at": "2026-06-23T00:00:00-05:00",
  "claims": [
    {
      "claim_id": "claim_001",
      "type": "file_modified",
      "risk": "medium",
      "statement": "Modified src/HealthChecker.ts.",
      "scope": {
        "repo": "pehlichi",
        "paths": ["src/HealthChecker.ts"]
      },
      "evidence_required": true,
      "evidence": []
    }
  ]
}
```

---

## Evidence Receipt Schema

```json
{
  "receipt_id": "receipt_001",
  "claim_id": "claim_001",
  "kind": "command",
  "created_at": "2026-06-23T00:00:00-05:00",
  "cwd": "/home/zen/repos/ecosystem/pehlichi",
  "git_root": "/home/zen/repos/ecosystem/pehlichi",
  "expected_repo": "pehlichi",
  "branch": "feature/truth-firewall",
  "command": "pnpm test",
  "exit_code": 0,
  "stdout_sha256": "abc123",
  "stderr_sha256": "def456",
  "duration_ms": 18321
}
```

---

## Truth Gate Modes

### FAST Mode
For ordinary tasks. Runs claim extraction, basic deterministic validators, hallucination log.

### STRICT Mode
Before commits, promotions, merges, or task closeout. Adds Verifier + Scope Auditor.

### PARANOID Mode
Before release readiness, shared memory updates, major architecture decisions. Adds Skeptic + Integration Reviewer + Memory Truth Curator.

---

## Routing Rules

```
Normal build task:
Builder → Verifier → Truth Gate

Claimed complete task:
Builder → Verifier → Scope Auditor → Truth Gate

Commit / merge / promotion:
Builder → Verifier → Scope Auditor → Skeptic → Truth Gate

Cross-repo or architecture task:
Builder → Verifier → Scope Auditor → Integration Reviewer → Truth Gate

Memory update:
Builder → Verifier → Memory Truth Curator → Truth Gate

Release readiness:
Builder → Verifier → Scope Auditor → Skeptic → Integration Reviewer → Memory Truth Curator → Truth Gate
```

---

## Implementation Phases

### Phase 1: Foundation
Agent registry, claim bundle schema, evidence receipt schema, verdict enum, storage layout, CLI skeleton.

### Phase 2: Deterministic Validators
file_exists, file_contains, git_diff_contains, command_exited_zero, tests_pass, build_passes, typescript_passes, git_status_clean, package_script_exists.

### Phase 3: Truth Gate
FAST / STRICT / PARANOID mode handling, claim risk classification, final task verdict generator.

### Phase 4: 6-Agent Routing
Agent role registry, routing rules, no-self-audit rule, mode-based verifier selection.

### Phase 5: Hallucination Log and Scorecard
Hallucination event log, agent reliability scorecard, summary report.

### Phase 6: Memory Proposal Gate
Memory proposal schema, review flow, verdicts, quarantine folder.

---

## Final Success Condition

A builder agent can no longer claim "done" or "tests pass" without producing evidence that the Truth Firewall can verify.
