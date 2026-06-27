/**
 * Velum — Three-Stage Guard
 * ============================================================
 * A unified trust boundary applied at three points:
 *
 *   Stage 1 — INPUT:   user input before model execution
 *   Stage 2 — CONTEXT: model-bound context (tool/system/assistant content)
 *   Stage 3 — OUTPUT:  generated model output before it is shown/accepted
 *
 * Decisions (ascending severity):
 *   allow  — proceed normally
 *   warn   — proceed, but record it
 *   review — elevated scrutiny / annotate
 *   block  — stop (input: refuse; output: redact + refuse)
 * ============================================================
 */
import { registry as defaultRegistry, ensureGlobal, } from "./patterns.js";
import { normalizeForScanning } from "./normalize.js";
import { scanPii, sanitizePii } from "./pii.js";
import { emitReceipt } from "./receipts.js";
const REDACTED_SECRET = "[REDACTED-SECRET]";
const DECISION_ORDER = { allow: 0, warn: 1, review: 2, block: 3 };
export function maxDecision(a, b) {
    return DECISION_ORDER[b] > DECISION_ORDER[a] ? b : a;
}
const severityToDecision = {
    block: "block",
    review: "review",
    warn: "warn",
};
function reset(re) {
    re.lastIndex = 0;
    return re;
}
/** Test an injection pattern against the text and its normalized form (H9). */
function injectionMatches(def, text, normalized) {
    if (reset(def.pattern).test(text))
        return true;
    if (normalized !== text && reset(def.pattern).test(normalized))
        return true;
    reset(def.pattern);
    return false;
}
/** Transform every string leaf in a bounded object/array tree. Pure. */
function deepTransform(value, fn, limits, depth, counter) {
    if (typeof value === "string") {
        if (counter.n >= limits.maxLeaves)
            return value;
        counter.n++;
        return fn(value);
    }
    if (depth >= limits.maxDepth || value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value)) {
        return value.map((v) => deepTransform(v, fn, limits, depth + 1, counter));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = deepTransform(v, fn, limits, depth + 1, counter);
    }
    return out;
}
/** Collect string leaves from known multimodal message shapes (H7). */
function extractStrings(value, limits, depth, counter, out) {
    if (counter.n >= limits.maxLeaves)
        return;
    if (typeof value === "string") {
        counter.n++;
        out.push(value);
        return;
    }
    if (depth >= limits.maxDepth || value === null || typeof value !== "object")
        return;
    if (Array.isArray(value)) {
        for (const v of value)
            extractStrings(v, limits, depth + 1, counter, out);
        return;
    }
    for (const v of Object.values(value)) {
        extractStrings(v, limits, depth + 1, counter, out);
    }
}
// ── Stage 1: INPUT ───────────────────────────────────────────────────────────
export function scanInput(text, registry = defaultRegistry) {
    const reasons = [];
    const flags = [];
    let decision = "allow";
    const trimmed = (text ?? "").trim();
    if (!trimmed)
        return { decision, reasons, flags };
    const normalized = normalizeForScanning(trimmed);
    for (const def of registry.injectionPatterns) {
        if (injectionMatches(def, trimmed, normalized)) {
            flags.push(def.name);
            reasons.push(`input:${def.name}`);
            decision = maxDecision(decision, severityToDecision[def.severity]);
        }
    }
    if (decision !== "allow" || flags.length > 0) {
        emitReceipt({ stage: "input", decision, patterns: flags });
    }
    return { decision, reasons, flags };
}
// ── Stage 2: CONTEXT ─────────────────────────────────────────────────────────
// Content here comes from *our* side of the trust boundary (tool output, system,
// prior assistant turns). Embedded injection is a strong signal of tainted data;
// embedded secrets must be redacted before reaching the model. User content is
// covered by scanInput and passes through untouched.
const CONTEXT_LIMITS = { maxDepth: 5, maxLeaves: 500 };
function redactSecretsInString(content, registry) {
    let out = content;
    const found = [];
    for (const def of registry.credentialPatterns) {
        const re = ensureGlobal(def.pattern);
        re.lastIndex = 0;
        if (re.test(out)) {
            found.push(def.name);
            re.lastIndex = 0;
            out = out.replace(re, REDACTED_SECRET);
        }
    }
    return { text: out, found };
}
export function scanContext(messages, registry = defaultRegistry) {
    const reasons = [];
    const flags = [];
    let decision = "allow";
    let didRedact = false;
    const redactedMessages = [];
    for (const msg of messages) {
        // User content is covered by scanInput; pass it through untouched.
        if (msg.role === "user") {
            redactedMessages.push(msg);
            continue;
        }
        if (typeof msg.content === "string") {
            const { newContent, changed } = scanContextString(msg, msg.content, registry, flags, reasons, (d) => {
                decision = maxDecision(decision, d);
            });
            if (changed)
                didRedact = true;
            redactedMessages.push({ role: msg.role, content: newContent });
            continue;
        }
        // ── Multimodal / structured content (H7) ──
        const strings = [];
        extractStrings(msg.content, CONTEXT_LIMITS, 0, { n: 0 }, strings);
        if (strings.length === 0) {
            redactedMessages.push(msg);
            continue;
        }
        const combined = strings.join("\n");
        const normalized = normalizeForScanning(combined);
        for (const def of registry.injectionPatterns) {
            if (injectionMatches(def, combined, normalized)) {
                flags.push(`${msg.role}:${def.name}`);
                reasons.push(`context-${msg.role}:${def.name}`);
                decision = maxDecision(decision, msg.role === "assistant" ? "warn" : "review");
            }
        }
        // Deep-redact embedded secrets inside the structure.
        let structChanged = false;
        const foundNames = new Set();
        const transformed = deepTransform(msg.content, (s) => {
            const { text, found } = redactSecretsInString(s, registry);
            if (found.length) {
                structChanged = true;
                for (const f of found)
                    foundNames.add(f);
            }
            return text;
        }, CONTEXT_LIMITS, 0, { n: 0 });
        if (structChanged) {
            didRedact = true;
            decision = maxDecision(decision, "warn");
            for (const f of foundNames) {
                flags.push(`${msg.role}:${f}`);
                reasons.push(`context-${msg.role}:${f}`);
            }
            redactedMessages.push({ role: msg.role, content: transformed });
        }
        else {
            redactedMessages.push(msg);
        }
    }
    const result = { decision, reasons, flags };
    if (didRedact) {
        result.redacted = redactedMessages
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n");
        result.redactedMessages = redactedMessages;
    }
    if (decision !== "allow" || flags.length > 0) {
        emitReceipt({
            stage: "context",
            decision,
            patterns: flags,
            counts: didRedact ? { redacted: 1 } : {},
        });
    }
    return result;
}
function scanContextString(msg, content, registry, flags, reasons, bump) {
    const normalized = normalizeForScanning(content);
    // Embedded injection — prior assistant turns are own-voice (warn), other
    // roles (tool/system/etc.) are higher risk (review).
    for (const def of registry.injectionPatterns) {
        if (injectionMatches(def, content, normalized)) {
            flags.push(`${msg.role}:${def.name}`);
            reasons.push(`context-${msg.role}:${def.name}`);
            bump(msg.role === "assistant" ? "warn" : "review");
        }
    }
    // Embedded secrets — redact in place.
    const { text, found } = redactSecretsInString(content, registry);
    for (const name of found) {
        flags.push(`${msg.role}:${name}`);
        reasons.push(`context-${msg.role}:${name}`);
        bump("warn");
    }
    return { newContent: text, changed: found.length > 0 };
}
// ── Stage 3: OUTPUT ──────────────────────────────────────────────────────────
/** Maximum bytes of output text to scan. Responses exceeding this are
 *  truncated before scanning to prevent resource exhaustion. 1 MiB default. */
const MAX_OUTPUT_SCAN_BYTES = 1 * 1024 * 1024;
export function scanOutput(text, registry = defaultRegistry, opts = {}) {
    const reasons = [];
    const flags = [];
    let decision = "allow";
    const source = text ?? "";
    if (!source)
        return { decision, reasons, flags };
    // Cap the scanned region to prevent resource exhaustion on huge outputs.
    const maxBytes = opts.maxScanBytes ?? MAX_OUTPUT_SCAN_BYTES;
    let scanRegion;
    if (Buffer.byteLength(source, "utf-8") > maxBytes) {
        scanRegion = Buffer.from(source, "utf-8").subarray(0, maxBytes).toString("utf-8");
        flags.push("OUTPUT_TRUNCATED");
        reasons.push(`output:truncated(${maxBytes} bytes)`);
        decision = maxDecision(decision, "warn");
    }
    else {
        scanRegion = source;
    }
    let redacted = scanRegion;
    let didRedact = false;
    // Secrets in output are an immediate block + redact.
    for (const def of registry.credentialPatterns) {
        const re = ensureGlobal(def.pattern);
        const matches = scanRegion.match(reset(re));
        if (matches && matches.length > 0) {
            flags.push(def.name);
            reasons.push(`output:${def.name}(${matches.length})`);
            decision = maxDecision(decision, "block");
            redacted = redacted.replace(reset(re), REDACTED_SECRET);
            didRedact = true;
        }
    }
    // Policy-weakening patterns → review (operators should see them).
    for (const def of registry.policyPatterns) {
        if (reset(def.pattern).test(scanRegion)) {
            flags.push(def.name);
            reasons.push(`output:${def.name}`);
            decision = maxDecision(decision, "review");
        }
    }
    // PII in output → redact when outputPiiLevel >= 2 (H5).
    if (opts.outputPiiLevel !== undefined && opts.outputPiiLevel >= 2) {
        const piiHits = scanPii(redacted, registry);
        if (piiHits.length > 0) {
            const types = new Set(piiHits.map((d) => d.type));
            for (const t of types) {
                flags.push(`PII:${t}`);
                reasons.push(`output-pii:${t}`);
            }
            decision = maxDecision(decision, "review");
            redacted = sanitizePii(redacted, registry);
            didRedact = true;
        }
    }
    const result = { decision, reasons, flags };
    if (didRedact)
        result.redacted = redacted;
    if (decision !== "allow" || flags.length > 0) {
        emitReceipt({
            stage: "output",
            decision,
            patterns: flags,
            counts: didRedact ? { redacted: 1 } : {},
        });
    }
    return result;
}
// ── Pure output-guard transform ──────────────────────────────────────────────
const IN_CHARACTER_REFUSAL = "I stopped that response before it left — it was about to include a secret. Ask again and I'll answer without the sensitive part.";
const NEUTRAL_REFUSAL = "Response blocked by policy (Velum output guard: potential secret leakage).";
function refusalText(inCharacter) {
    return inCharacter ? IN_CHARACTER_REFUSAL : NEUTRAL_REFUSAL;
}
/**
 * Scan a candidate model output and return the text the client should see:
 *   - block  → a refusal substitute (never the original)
 *   - secret redacted (non-block) → the redacted text
 *   - otherwise → the original text
 * Always returns non-empty text on block.
 */
export function applyOutputGuardSync(text, opts = { inCharacter: false }, registry = defaultRegistry) {
    const inCharacter = opts.inCharacter ?? false;
    const scan = scanOutput(text ?? "", registry, { outputPiiLevel: opts.outputPiiLevel });
    if (scan.decision === "block") {
        return { text: refusalText(inCharacter), scan, blocked: true, redacted: false };
    }
    if (scan.redacted) {
        return { text: scan.redacted, scan, blocked: false, redacted: true };
    }
    return { text: text ?? "", scan, blocked: false, redacted: false };
}
// ── Streaming output guard ────────────────────────────────────────────────────
// Token-by-token LLM output breaks the single-string assumption: a secret split
// across two SSE chunks ("sk-" … "XXXX") passes both chunk scans undetected, and
// buffering the whole response defeats streaming. createOutputStreamGuard keeps a
// sliding tail-buffer sized to the longest credential we care about and only
// releases bytes that cannot be part of a not-yet-complete match.
/** Upper bound on a credential match we hold back across chunks. */
const STREAM_TAIL_BYTES = 512;
/**
 * Build a streaming output guard. As chunks arrive they accumulate in a buffer;
 * the joined text is scanned so a secret spanning a chunk boundary is caught.
 * Bytes older than the tail window can't be part of a still-forming secret (any
 * secret touching them would already be complete and detected), so they're
 * released. On a credential block the guard emits a single refusal and closes:
 * every subsequent push() and the final flush() return "".
 */
export function createOutputStreamGuard(opts = {}, registry = defaultRegistry) {
    const tail = Math.max(16, opts.tailBytes ?? STREAM_TAIL_BYTES);
    const inCharacter = opts.inCharacter ?? false;
    let buffer = "";
    let closed = false;
    /** True when the buffer contains a complete credential (block) match. */
    function hasSecret(text) {
        const scan = scanOutput(text, registry);
        return scan.decision === "block";
    }
    return {
        get blocked() {
            return closed;
        },
        push(chunk) {
            if (closed)
                return "";
            buffer += chunk ?? "";
            if (hasSecret(buffer)) {
                closed = true;
                buffer = "";
                return refusalText(inCharacter);
            }
            // Release everything except the last `tail` bytes — those might be the
            // start of a secret that completes in a later chunk.
            if (buffer.length <= tail)
                return "";
            const releaseLen = buffer.length - tail;
            const release = buffer.slice(0, releaseLen);
            buffer = buffer.slice(releaseLen);
            return release;
        },
        flush() {
            if (closed)
                return "";
            const result = applyOutputGuardSync(buffer, opts, registry);
            buffer = "";
            if (result.blocked) {
                closed = true;
                return result.text; // refusal
            }
            return result.text; // original or redacted (PII at outputPiiLevel >= 2)
        },
    };
}
const OUTPUT_LIMITS = { maxDepth: 10, maxLeaves: 1000 };
/**
 * Recursively scan a model response — a string OR a nested object/array shape
 * such as `{ choices: [{ message: { content: "…" } }] }` — and guard every
 * string leaf. Blocked leaves become a refusal; redacted leaves become their
 * sanitized text (H2).
 */
export function deepScanOutput(input, opts = {}, registry = defaultRegistry) {
    if (typeof input === "string") {
        const r = applyOutputGuardSync(input, opts, registry);
        return { value: r.text, scan: r.scan, blocked: r.blocked, redacted: r.redacted };
    }
    const flags = [];
    const reasons = [];
    let decision = "allow";
    let blocked = false;
    let redacted = false;
    const value = deepTransform(input, (s) => {
        const r = applyOutputGuardSync(s, opts, registry);
        decision = maxDecision(decision, r.scan.decision);
        flags.push(...r.scan.flags);
        reasons.push(...r.scan.reasons);
        if (r.blocked)
            blocked = true;
        if (r.redacted)
            redacted = true;
        return r.text;
    }, OUTPUT_LIMITS, 0, { n: 0 });
    return { value, scan: { decision, reasons, flags }, blocked, redacted };
}
//# sourceMappingURL=guard.js.map