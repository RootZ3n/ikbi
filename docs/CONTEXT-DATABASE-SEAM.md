# The repair-history / context-database seam

Design only. Nothing here is implemented, and nothing here should be implemented until the
questions in "Open questions" have operator answers.

## What this seam is for

ikbi already knows, for one build, what was attempted and what happened. It forgets all of it the
moment the run ends, except as receipts nobody queries. An external context database (More Input /
Archivum) would let a later build ask "has this been tried, and what came of it?".

That is useful and it is dangerous in a specific way: a store of past attempts is a store of
**claims**, and the entire design of the v2 engine is that a claim is not evidence. The seam below
exists to make retrieved history usable *as evidence about the past* while making it structurally
incapable of granting authority in the present.

## The one rule

**Retrieval is a source of context, never a source of authority.**

A retrieved record may inform a prompt, order a search, or warn an operator. It may never:

- satisfy a verification,
- substitute for running a check,
- authorize a mutation, a promotion, or a qualification,
- raise a trust tier,
- mark a target verified.

This is the same rule the local-advisory lane already follows, and it should reuse the same
machinery: retrieved text enters the model's context through the untrusted-data fence, exactly as
repository bytes and tool output do, and is recorded as its own receipt layer.

## Record states

Six states, deliberately distinct. Collapsing any two of them is how a store of attempts becomes a
store of conclusions.

| state | means | who can set it |
|---|---|---|
| `observed` | this happened; no claim about whether it was right | the engine, from its own ledger |
| `proposed` | a model suggested this | the engine, recording a model output |
| `verified` | deterministic checks passed on a named tree | the verification authority ONLY |
| `operator_accepted` | a human looked at it and accepted it | an operator identity ONLY |
| `superseded` | a later record replaces this one | the engine, naming the successor |
| `refuted` | a later run showed this to be wrong | the engine or an operator, naming the evidence |

`verified` is about a **tree digest**, never about a goal or a description. `operator_accepted` is
never inferred from a promotion: promotion means the disposition authority found the candidate
eligible, which is not the same as a person having read it.

## The record contract (v1)

Versioned, additive-only, and refused if the version is unknown — the same fail-closed posture the
Bokahli adapter takes toward an outcome it does not recognize.

```jsonc
{
  "contractVersion": "ikbi/repair-history/1",
  "recordId": "rh_<uuid>",
  "state": "observed | proposed | verified | operator_accepted | superseded | refuted",

  // FROZEN TASK IDENTITY — the digest, not the prose. Two builds share a task identity only if
  // they were asked the same thing, byte for byte, after canonicalization.
  "task": {
    "canonicalGoalSha256": "sha256:…",
    "taskId": "task_<uuid>",
    "buildSessionId": "sess_<uuid>"
  },

  // WHERE. Repository identity is the git common dir realpath'd, as promotion already uses.
  "subject": {
    "repositoryIdentity": "sha256:…",     // hashed, not the operator's path
    "baseCommit": "<sha1>",
    "baseTree": "<sha1>",
    "files": [{ "path": "src/x.ts", "blob": "<sha1>" }],
    "symbols": [{ "path": "src/x.ts", "symbol": "adjudicate", "kind": "function" }]
  },

  // WHAT WAS TRIED, and how it failed. The signature is what makes two failures comparable.
  "attempt": {
    "attemptNumber": 1,
    "failureSignature": "sha256:…",       // normalized: check name + exit + canonicalized message
    "failureClass": "check_failed | build_error | type_error | timeout | refused | …",
    "checkName": "unit",
    "exitCode": 1
  },

  // THE PATCH, by digest. The bytes live in git; this stores what to go look at.
  "patch": {
    "candidateTreeId": "<sha1>",
    "diffSha256": "sha256:…",
    "changedPaths": ["src/x.ts"]
  },

  // DETERMINISTIC RESULTS ONLY. A model's opinion never appears in this object.
  "verification": {
    "verificationId": "…",
    "treeVerified": "<sha1>",
    "checks": [{ "name": "unit", "status": "green|red|unresolvable", "exitCode": 0 }],
    "unverifiableTargets": []
  },

  // WHO PRODUCED IT — the artifact, not just a model name.
  "producer": {
    "authorizedModelId": "…",
    "sentProviderId": "…",
    "servedModelId": "…",
    "artifactDigest": "sha256:…",
    "runtimeProfileId": "…",
    "executionClass": "remote | local",
    "qualificationStatus": "QUALIFIED | INSTALLED_UNQUALIFIED | UNKNOWN"
  },

  // WHAT WAS RETRIEVED TO PRODUCE IT, so a later reader can re-derive rather than believe.
  "retrieval": {
    "packetDigest": "sha256:…",
    "citations": [{ "recordId": "rh_…", "quote": "…", "resolved": true }]
  },

  "supersedes": ["rh_…"],
  "refutes": ["rh_…"],
  "recordedAt": 1787441850644
}
```

## What must never be stored

- **No secrets.** No credential values, no tokens, no `.env` contents, no Authorization headers.
  The producer records an artifact digest, never the key used to reach it.
- **No raw operator paths.** `repositoryIdentity` is a digest. A history store that leaks a
  machine's directory layout is a different kind of artifact than intended.
- **No model prose in a deterministic field.** A critic verdict is a `proposed` record, never part
  of `verification`.

## How ikbi would consume it

1. Retrieval produces a bounded packet with a digest, exactly like `PRE_BUILD_RECON` does today.
2. The packet enters the prompt through the untrusted fence, marked as retrieved history.
3. Citations must resolve verbatim into the packet, or the packet is discarded — the same
   deterministic validator discipline the local lane already applies.
4. A `local.retrieval` receipt records the packet digest, which records were cited, and whether the
   packet was supplied to the primary provider. This sits beside `run.summary`,
   `workspace.promote`, `local.advisory` and `govexec.run` as a fifth, separable authority layer.

## Open questions for the operator

1. **Scope of identity.** Should `repositoryIdentity` be per-checkout or per-origin? Per-origin
   makes history shareable between machines and makes a poisoned record travel.
2. **Who may write `operator_accepted`?** It needs an operator identity and probably a MAC, or it
   is just another field a process can set.
3. **Refutation authority.** A later red run refutes an earlier `verified` record only if the trees
   are comparable. What happens when they are not?
4. **Retention.** A failure signature is useful for months; a diff digest for a deleted branch is
   not. There is no proposal here for expiry, and there should be one before storage exists.
