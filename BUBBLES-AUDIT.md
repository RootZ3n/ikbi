# BUBBLES FINAL-PASS AUDIT: ikbi

Date: June 17, 2026
Auditor: Bubbles (Hermes Agent, deepseek-v4-pro)
Scope: Seven audit areas neither Claude Code Opus nor Codex gpt-5.5 covered

## Overall Verdict

The first two auditors caught real product gaps — README lies, raw stack traces, CLI
pollution, missing streaming, the skeleton label, and so on. They did NOT go deep on
the runtime security surface, the provider layer's failure modes, cross-process state
safety, or the honesty of the architectural claims at the code level.

I found real gaps in all four of those areas. The injection chokepoint's fence is
mathematically sound, but its scanner's "block" recommendation is dead code — a
broken promise in the contract. The workspace allocation max bound is per-process when
it needs to be cross-process. The session-store lock has a mkdir-based retry race.
And the governed-exec fetch has no response size bound — a gibibyte response from a
compromised endpoint would OOM the process.

The honest take: the hard problems (fence, retry, circuit breaker, promote durability,
receipt integrity) are well-solved. The gaps are in the SECOND-ORDER properties —
cross-process correctness, defense-in-depth honesty, and bounds that fail closed
instead of open.

------------------------------------------------------------------------
## HIGH FINDINGS
------------------------------------------------------------------------

### HIGH-1: Scanner "block" recommendation is dead code — never enforced

References:
- src/core/injection/contract.ts:96-103 (defines recommendedAction semantics)
- src/core/injection/index.ts:64-153 (neutralizeUntrusted logs but never gates)
- No consuming code anywhere reads scan.recommendedAction

What the user experiences:

The scanner detects high-confidence injection patterns and says "I recommend you BLOCK
this." It even has a nice `recommendedAction: "block"` field. But NOTHING in the
entire codebase reads that field. The injection contract says:

  "detected — a high-signal pattern matched; recommended to gate/block or
   require explicit operator/elevated-trust approval."

This is an unfulfilled promise. The content is fenced and defanged (which is real
protection), but the "block" tier described in the contract does not exist in the
runtime. A user who reads the contract thinking high-confidence injections will be
blocked is being misled about the actual safety guarantee.

Why both auditors missed it:

Both auditors read the injection contract and saw the defense-in-depth (fence +
defang + isolation), which is genuinely well-designed. Neither traced the
`recommendedAction` field to its consumers — because there ARE none. It's logged at
src/core/injection/index.ts:131 and never read again.

Fix recommendation:

EITHER:
(a) Wire the block recommendation: in the builder's tool-result path
    (builder.ts appendToolResult), check `safe.scan.recommendedAction === "block"`
    and refuse to feed the content to the model (or require elevation).
OR:
(b) Remove the `recommendedAction` field from the contract and stop promising a
    blocking tier that doesn't exist. The honest scanner contract already says
    "wrapping/isolation are unconditional regardless of verdict." Keep it honest.

------------------------------------------------------------------------

### HIGH-2: Workspace allocation `max` bound is per-process, not cross-process

References:
- src/core/workspace/manager.ts:155-213 (allocate method)
- src/core/workspace/manager.ts:94 (ALLOC_LOCK = "workspace:alloc")
- src/core/workspace/manager.ts:160 (live.size >= max check)

What the user experiences:

ikbi is designed to run as BOTH a CLI and a long-running server (port 18796). The
workspace manager enforces a max workspace count (default 32) to bound disk usage.
This check uses `this.live.size >= this.max` (line 161), where `live` is an in-memory
Map rebuilt from the persistent store on `preload()`.

The allocation lock (`ALLOC_LOCK = "workspace:alloc"`) is passed to `withLock` with NO
file lock option — it's an in-process mutex only. Two processes (e.g., `ikbi build`
from CLI + the server handling an HTTP `/chat` request that allocates a workspace) can
each:

1. Call `preload()` — both see the persistent store, both load into their OWN `live` Map
2. Pass the `live.size >= max` check (both see, say, 31 workspaces)
3. Proceed to allocate #32 and #33 simultaneously

The git worktree creation prevents branch-name collisions (random 8-byte hex IDs), so
the system doesn't crash — but the operator-configured max bound is silently violated.
Over time, repeated concurrent allocation can accumulate workspaces well past the
intended limit.

Why both auditors missed it:

The workspace isolation tests (workspace-isolation.test.ts) test path confinement and
inter-worktree isolation, but all tests run in a single process against a single
WorkspaceManager instance. No test exercises two concurrent allocate() calls from
separate processes.

Fix recommendation:

Add a file lock to the ALLOC_LOCK path by passing `{ file: join(this.root, "alloc.lock") }`
to the `withLock` call in `allocate()`. This serializes allocation across processes so
the preload + check + allocate sequence is atomic across the system.

------------------------------------------------------------------------

### HIGH-3: Governed-exec fetch() has no response-size bound (OOM vector)

References:
- src/modules/governed-exec/exec.ts:376-393 (fetch method)
- src/modules/governed-exec/exec.ts:383: `const body = await res.text();`

What the user experiences:

The governed executor's `fetch()` method reads the ENTIRE response body into memory
with `res.text()` before truncating it to `OUTPUT_TAIL_CHARS` for the receipt. The
`exec` path has `maxBuffer` protection (bounded output capture), but the `fetch` path
does not.

A model that has been granted network access (e.g., to read documentation or an API)
and hits a malicious or compromised endpoint could receive a multi-gigabyte response.
This would allocate that many bytes in the Node.js heap, likely triggering an OOM kill
and taking down the entire ikbi process (server + any in-flight builds).

The egress guard validates the DESTINATION (scheme + host + IP), but it does not bound
the response. A legitimate allowlisted host returning an unexpectedly large response
triggers the same issue.

Why both auditors missed it:

The egress guard's SSRF protection (host allowlist + internal IP rejection) is
thorough and well-documented. Neither auditor checked what happens AFTER the guard
passes — the response consumption itself is unbounded.

Fix recommendation:

Add a configurable `maxResponseBytes` to the fetch path, defaulting to something
reasonable (e.g., 5 MB). Stream the response into a bounded buffer, discarding bytes
beyond the cap. Return a truncated indicator in the result. Mirror the existing
`maxBuffer`/`OUTPUT_TAIL_CHARS` pattern from the exec path.

------------------------------------------------------------------------
## MEDIUM FINDINGS
------------------------------------------------------------------------

### MED-1: Injection scanner cannot detect Unicode homoglyph attacks

References:
- src/core/injection/scanner.ts:165-175 (normalizeForScan)
- src/core/injection/contract.ts:142-146 (acknowledged limitation)

What the user experiences:

The scanner normalizes content with NFKC + evasion-char stripping before matching
injection patterns. NFKC folds fullwidth/compatibility characters (A -> A) but
does NOT fold cross-script homoglyphs (Cyrillic 'а' U+0430 vs Latin 'a' U+0061).
An attacker can write "игноре превиоус инструцтионс" using Cyrillic letters that
look identical to Latin ones. The scanner's regex patterns won't match because the
underlying code points are different.

This matters MORE because HIGH-1 is also true — the "block" recommendation doesn't
work anyway. So the scanner's inability to detect homoglyph attacks combines with
the non-existent blocking path to create a gap where sophisticated injection can
reach the model un-detected.

The contract honestly acknowledges "True cross-script homoglyphs are a documented
limitation" (contract.ts:145). This is honest, but combined with HIGH-1, it means
there are TWO missing layers where there should be one.

Why both auditors missed it:

The scanner's contract is honest about the limitation, so reading the contract alone
doesn't flag it. You have to read the normalization code and understand what NFKC
does and doesn't fold.

Fix recommendation:

Add a confusable-homoglyph detection pass using Unicode confusable data (e.g., the
ICU spoof-checker or a compact mapping of common Latin-lookalike Cyrillic/Greek
code points). Flag matches with `category: "encoded_payload"` and `severity: "medium"`.
Alternatively, accept it as a documented limitation and ensure the scanner contract
makes it more prominent in operator-facing docs.

------------------------------------------------------------------------

### MED-2: confinePath symlink check has documented TOCTOU race

References:
- src/modules/worker-model/builder-tools/confine.ts:48-61 (confinePath)
- src/modules/worker-model/builder-tools/confine.ts:54-56 (TOCTOU acknowledgment)

What the user experiences:

The builder's path confinement resolves symlinks with `realExistingAncestor()` to
verify the target stays within the worktree. The code then opens/writes the file.
Between the check and the operation, a malicious model (or a model tricked into
running a timed exploit) could swap a symlink to point outside the worktree.

The code HONESTLY documents this: "Known TOCTOU window between realpath check and
file operation. Exploitation requires attacker write access to worktree +
microsecond timing. Node.js lacks atomic path resolution; this is an accepted risk."

This is about as well-handled as it can be without kernel support. The risk is
narrow: the attacker needs write access to the worktree (which the model has by
design) AND microsecond timing. I'm listing it because the path-containment
guarantee in the builder's security invariants (builder.ts:19-22) says "rejected
if it escapes via symlink escape" — which is a stronger claim than the code can
actually deliver.

Why both auditors missed it:

The comment in the code is honest and the TOCTOU is acknowledged. Most auditors
would read "accepted risk" and move on. But the builder's security-critical
invariants header (builder.ts lines 19-22) overstates the guarantee.

Fix recommendation:

Either soften the invariant claim in builder.ts to acknowledge the TOCTOU, or
implement a mitigation (e.g., open the file with O_NOFOLLOW on platforms that
support it, then fstat + realpath the fd to compare).

------------------------------------------------------------------------

### MED-3: Session-store lock has narrow mkdir retry race

References:
- src/modules/chat/session-store.ts:173-193 (acquireLock)
- src/modules/chat/session-store.ts:190-191 (rmSync between checks)

What the user experiences:

The persistent session store uses `mkdirSync(lockDir)` as a test-and-set lock.
When it finds a stale lock, it `rmSync`s the lock directory and retries the
`mkdirSync`. Two processes both trying to reclaim the SAME stale lock can race:

1. Process A sees EEXIST, reads owner (dead pid), rmSync
2. Process B also sees EEXIST, reads owner (dead pid), rmSync (no-op, A already
   removed it)
3. Process B's `mkdirSync` succeeds first
4. Process A's `mkdirSync` on retry sees EEXIST (B holds it now)
5. Process A reads B's owner, sees live pid, throws SessionLockedError

The result is a SPURIOUS lock-contention error (Process A is told "session locked
by PID <B's pid>" even though both were legitimate reclaims). The user sees an error
message telling them to use `--force` or try a different session, when the real
issue is just a reclaim race.

No data corruption occurs — it's a false-positive error. But it's confusing and
actionable with the wrong action.

Why both auditors missed it:

The session-store lock looks correct on first read. You have to trace the exact
interleaving of two concurrent reclaims to spot the race. The substrate LockManager
correctly uses `open("wx")` which is atomic — the session store uses `mkdir` which
has a retry race in the reclaim path.

Fix recommendation:

Replace the `mkdir`-based lock with the same `open("wx")` approach used by the
substrate LockManager. Create a `.lock` FILE instead of a directory, using
`open(lockFile, "wx")` for atomic test-and-set.

------------------------------------------------------------------------

### MED-4: AtomicAppendLog for receipts has no cross-process locking by default

References:
- src/core/substrate/append.ts:71 (crossProcess defaults to false)
- src/core/receipt/store.ts:99-100 (appendKey is in-process only)

What the user experiences:

The receipt store uses `AtomicAppendLog` as its backing storage. The append log
defaults `crossProcess: false`, meaning appends are serialized in-process only.
The receipt store adds its own lock key (`receipt:${resolve(deps.logFile)}`), but
this lock is ALSO in-process only (no file lock option passed to `withLock`).

In production, the CLI reads receipts while the server writes them. A `readAll()`
during a concurrent `append()` could return a partial line (the torn-tail repair
in `append()` truncates before the next append, but there's a window where the
repair hasn't happened yet). This is an edge case — the torn-tail repair in
`append()` (line 182-203 of append.ts) scans the last 1MB and truncates partial
lines, but it runs INSIDE the write lock. A reader outside the lock could see the
partial line before repair.

More critically: two concurrent appends (from different processes) could interleave
bytes at the OS level, corrupting the log. The NDJSON format is line-delimited so
corruption is detectable, but it's still data loss.

Why both auditors missed it:

The atomic append log is well-documented and the torn-tail repair is clever.
Neither auditor tested concurrent read-during-write from separate processes.

Fix recommendation:

Set `crossProcess: true` on the AtomicAppendLog for the receipt store, with a
file lock. Also pass the file lock option to the receipt store's `appendKey` lock.

------------------------------------------------------------------------
## LOW FINDINGS
------------------------------------------------------------------------

### LOW-1: No disk-full handling in atomic writes (ENOSPC not distinguished)

References:
- src/core/substrate/atomic.ts:78-123 (atomicWriteFile)

What the user experiences:

`atomicWriteFile` writes to a temp file, fsyncs, then renames. On a disk-full
condition (ENOSPC), the `writeFile` fails but the error thrown is a generic
`SubstrateError("write_failed", ...)` — the ENOSPC error code is not preserved as
a structured field. The caller can't distinguish "disk full" from "permission denied"
or "I/O error" programmatically.

More importantly, the temp file might be created (open succeeds with `wx`) but the
write partially fails, leaving an orphaned temp file. `sweepTempFiles` eventually
cleans these up, but only if they're older than 60 seconds. A full disk combined
with rapid retries could accumulate temp files.

Why both auditors missed it:

The atomic write pattern (temp + fsync + rename) is textbook-correct. The edge-case
handling of ENOSPC specifically is a subtle quality-of-implementation concern.

Fix recommendation:

Catch ENOSPC specifically and surface it as a structured error field (e.g.,
`SubstrateError("disk_full", ...)`). Consider immediate cleanup of the temp file on
ENOSPC to avoid temp-file accumulation.

------------------------------------------------------------------------

### LOW-2: CLI `ikbi build` can leave workspace records in `live` map that drift from persistent store

References:
- src/core/workspace/manager.ts:108-109 (live Map)
- src/core/workspace/manager.ts:127-151 (preload)

What the user experiences:

The `live` Map caches workspace records for the lifetime of the in-process
WorkspaceManager. When the CLI runs `ikbi build`, it creates a WorkspaceManager,
allocates, builds, and exits. On exit, the `live` Map is discarded — but the
persistent store has the workspaces. The next `ikbi build` (new process) calls
`preload()` which reloads from the persistent store. This is correct behavior.

BUT: if a long-running process (the server) and a CLI command share the SAME
persistent store, the server's `live` Map can drift from reality. The server
allocated workspace #5 three hours ago, the CLI just discarded it — the server's
`live` Map still has it. This causes the `live.size` bound check to over-count,
potentially blocking allocation even though slots are free. A call to `preload()`
would fix it, but `preload()` is cached (`initPromise`) after the first call.

Why both auditors missed it:

The `preload()` cache is a performance optimization that works correctly in
single-process scenarios. The cross-process drift on the `live` Map is a subtle
interaction between the cache and the lack of cross-process invalidation.

Fix recommendation:

Either invalidate the `preload()` cache periodically (on a timer, or on allocation
failure), or rely entirely on the persistent store for the count (query the store
directly instead of `live.size`). The current design works correctly for CLI-only
usage but drifts under mixed CLI+server usage.

------------------------------------------------------------------------

### LOW-3: Model returning non-existent tool call creates confusing error

References:
- src/modules/worker-model/builder.ts (runTool dispatches by tool name)

What the user experiences:

If a model hallucinates a tool name that doesn't exist in the builder's tool set,
the builder returns a tool error like "unknown tool: hallucinated_function". This
error IS fed back to the model (properly fenced), so the model can self-correct.
However, the error message includes the raw (untrusted) tool name:

  `error: "unknown tool: ${tc.function.name}"`

This tool name comes from the MODEL'S output (untrusted) and is embedded into a
tool result string that flows through the neutralization chokepoint. The
chokepoint should handle this correctly — but the error string is constructed
BEFORE neutralization, and embeds untrusted text. If the chokepoint is bypassed
(unlikely but worth noting), this is an injection vector.

More practically: the error is opaque to the user. The user sees "unknown tool:
some_hallucination" in the debug output but there's no user-facing indication
that the model is confused about tool names vs. a legitimate failure.

Why both auditors missed it:

This is a deep quality-of-life issue in the builder's tool dispatch. Most audits
focus on the happy path.

Fix recommendation:

Sanitize the tool name before embedding it in the error string (it's model output,
so it IS untrusted). Add a structured rejection reason that doesn't echo the raw
tool name.

------------------------------------------------------------------------
## THINGS THE CODE DOES RIGHT (despite the gaps)

These things impressed me and are worth calling out because they're genuinely
well-engineered:

1. **The fence system is mathematically sound.** The verified-absent nonce
   guarantee (nonce checked twice: generation AND buildWrapped) combined with
   standalone-line anchor markers means the containment property is provable,
   not probabilistic. This is rare and excellent.

2. **Promote crash-safety is thorough.** The record-then-CAS pattern, the
   promoting-intent record, the reconcile-on-startup logic, and the
   PROMOTED_BUT_RECEIPT_FAILED degraded state all work together correctly.
   A kill -9 mid-promote won't lose a landed mutation.

3. **The circuit breaker's half-open concurrency bound is correctly implemented.**
   The slot reservation in `canAttempt()` prevents thundering-herd on recovery,
   and the separation of probe-counting from state transition prevents races.

4. **Torn-tail repair in the append log.** Scanning for the last newline on
   append and truncating partial lines is exactly the right approach for an
   NDJSON log.

5. **The egress guard's IP classification is comprehensive.** IPv4-mapped IPv6
   addresses are extracted and the embedded IPv4 is re-classified. The metadata
   IP (169.254.169.254) is called out explicitly.

------------------------------------------------------------------------
## AUDIT AREA COVERAGE MAP

| Area                          | CC Opus | Codex | Bubbles |
|-------------------------------|---------|-------|---------|
| README / docs honesty         | RED     | LOW   | —       |
| CLI error paths               | —       | HIGH  | —       |
| Doctor readiness lies         | —       | HIGH  | —       |
| CLI output pollution          | —       | HIGH  | —       |
| Text-tool emulation gap       | —       | HIGH  | —       |
| REPL resume failures          | —       | HIGH  | —       |
| Injection chokepoint          | —       | —     | HIGH-1  |
| Cross-process workspace bound | —       | —     | HIGH-2  |
| Fetch response size bound     | —       | —     | HIGH-3  |
| Scanner homoglyph detection   | —       | —     | MED-1   |
| confinePath TOCTOU            | —       | —     | MED-2   |
| Session-store lock race       | —       | —     | MED-3   |
| Receipt log cross-proc        | —       | —     | MED-4   |
| Disk-full handling            | —       | —     | LOW-1   |
| live-Map cross-process drift  | —       | —     | LOW-2   |
| Hallucinated tool errors      | —       | —     | LOW-3   |

------------------------------------------------------------------------
## SUMMARY

The first two auditors did surface-level and UX audits well. They missed the
RUNTIME BEHAVIOR layer: cross-process safety, defense-in-depth honesty, failure
modes under resource constraints, and the gap between what the contract promises
and what the code delivers.

The three HIGH findings are:
1. Scanner "block" recommendation is dead code — the defense-in-depth is thinner
   than the contract claims
2. Workspace max bound is per-process — concurrent CLI + server can exceed it
3. Governed-exec fetch() has no response limit — a large response can OOM the
   process

The MED findings are all real but narrower: the homoglyph gap in the scanner,
the confinePath TOCTOU, the session-store lock race, and the receipt store's
lack of cross-process locking.

ikbi's foundations are genuinely strong. The atomic writes, promote crash-safety,
circuit breaker, and fence system are all well-designed. The gaps are in the
integration layer — what happens when TWO processes try to use it, and what
happens when a defense (like the scanner) promises more than it delivers.
