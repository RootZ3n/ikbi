/**
 * Velum — Pattern Registry
 * ============================================================
 * The foundation of Velum. Every other core module (classify, guard, pii)
 * consumes its detection patterns from this registry. Patterns are grouped
 * by category and carry a severity hint used by the guard stages.
 *
 * The registry is extensible at runtime: callers can add custom patterns,
 * remove built-ins, or look one up by name.
 * ============================================================
 */

export type PatternCategory = "credential" | "injection" | "pii" | "policy";
export type PatternSeverity = "block" | "review" | "warn";
/**
 * Detection confidence:
 *  - "high": distinctive prefix/shape (sk-…, AKIA…, ghp_…) — a real secret; it
 *    must NEVER be suppressed by neverRedact (H6).
 *  - "low": generic assignment/heuristic (api_key=…) — may collide with safe
 *    terms, so neverRedact filtering applies.
 * Defaults to "low" when omitted (backward compatible).
 */
export type PatternConfidence = "high" | "low";

export interface PatternDefinition {
  name: string;
  pattern: RegExp;
  category: PatternCategory;
  severity: PatternSeverity;
  description: string;
  /** Detection confidence — gates neverRedact suppression for credentials. */
  confidence?: PatternConfidence;
}

export interface PatternRegistry {
  credentialPatterns: PatternDefinition[];
  injectionPatterns: PatternDefinition[];
  piiPatterns: PatternDefinition[];
  policyPatterns: PatternDefinition[];
  neverRedact: Set<string>;
  addPattern(def: PatternDefinition): void;
  removePattern(name: string): void;
  getPattern(name: string): PatternDefinition | undefined;
}

// ── NEVER_REDACT: known-safe terms that must survive credential matching ─────
// Includes Pehverse tool names, common providers, and infrastructure terms so
// that "openai.client" or "velum-guard" are never mistaken for secrets.
export const DEFAULT_NEVER_REDACT: readonly string[] = [
  "ollama", "openai", "anthropic", "minimax", "openrouter", "telegram", "modelstudio",
  "godot", "wyrms", "peh", "velum", "ikbi", "pehlichi", "ptah", "luna", "toba",
  "nusika", "luak", "howa", "kokuli", "gmail", "desktop", "system", "mesh",
  "benchmark", "proton", "steam", "provider", "health", "shaders", "controllers",
  "performance",
];

// ── Credential patterns (global — used with exec/match/replace) ──────────────
// Ordered by specificity: distinctive-prefix patterns first, generic last.
const CREDENTIAL_PATTERNS: PatternDefinition[] = [
  {
    name: "google_oauth_secret",
    pattern: /GOCSPX-[A-Za-z0-9_-]{10,}/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Google OAuth client secret (GOCSPX- prefix)",
  },
  {
    name: "google_client_id",
    pattern: /\d{10,}[A-Za-z0-9-]*\.apps\.googleusercontent\.com/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Google OAuth client ID (.apps.googleusercontent.com)",
  },
  {
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "AWS access key ID (AKIA prefix)",
  },
  {
    name: "aws_secret_access_key",
    pattern: /(?:aws_secret_access_key|aws_secret_key|secret_access_key)\s*[=:]\s*["']?[A-Za-z0-9/+]{40}["']?/gi,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "AWS secret access key (40-char base64, labelled)",
  },
  {
    name: "private_key_block",
    pattern: /-----BEGIN[A-Z\s]*PRIVATE KEY-----(?:[\s\S]*?-----END[A-Z\s]*PRIVATE KEY-----)?/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "PEM private key block",
  },
  {
    name: "ssh_private_key",
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----(?:[\s\S]*?-----END OPENSSH PRIVATE KEY-----)?/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "OpenSSH private key block",
  },
  {
    name: "anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9\-_]{32,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Anthropic API key (sk-ant- prefix)",
  },
  {
    name: "openai_key",
    pattern: /\bsk-[A-Za-z0-9]{40,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "OpenAI API key (sk- prefix, 40+ chars)",
  },
  {
    name: "stripe_key",
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Stripe secret/restricted/publishable key (sk_live_, sk_test_, …)",
  },
  {
    name: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "GitHub personal/OAuth/server/refresh token",
  },
  {
    name: "npm_token",
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "npm access token (npm_ prefix)",
  },
  {
    name: "huggingface_token",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Hugging Face access token (hf_ prefix)",
  },
  {
    name: "vercel_token",
    pattern: /(?:vercel|VERCEL)_?(?:token|TOKEN)\s*[=:]\s*["']?[A-Za-z0-9]{20,}["']?/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Vercel token (labelled assignment)",
  },
  {
    name: "netlify_token",
    pattern: /(?:netlify|NETLIFY)_?(?:auth_?token|AUTH_?TOKEN|token|TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}["']?/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Netlify auth token (labelled assignment)",
  },
  {
    name: "supabase_service_key",
    pattern: /\bsbp_[A-Za-z0-9]{36,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Supabase service/access token (sbp_ prefix)",
  },
  {
    name: "azure_secret",
    pattern: /(?:azure|AZURE)_?(?:client_?secret|CLIENT_?SECRET|secret|SECRET)\s*[=:]\s*["']?[A-Za-z0-9~._-]{20,}["']?/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Azure client secret (labelled assignment)",
  },
  {
    name: "database_url",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Database connection URL with embedded credentials",
  },
  {
    name: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Slack token (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-)",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    category: "credential",
    severity: "review",
    confidence: "high",
    description: "JSON Web Token (three base64url segments)",
  },
  {
    name: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{40,}=*/gi,
    category: "credential",
    severity: "block",
    confidence: "high",
    description: "Bearer authorization token (40+ chars)",
  },
  {
    name: "generic_secret_assignment",
    pattern: /(?:client_secret|secret_key|api_key|access_token|refresh_token|password|token)\s*[=:]\s*["']?[A-Za-z0-9\-._~+/]{40,}["']?/gi,
    category: "credential",
    severity: "block",
    confidence: "low",
    description: "Generic secret assignment (api_key=, password=, …) with a 40+ char value",
  },
];

// ── Injection patterns (non-global — used with test()) ───────────────────────
// Severity drives the input-guard decision: block > review > warn.
const INJECTION_PATTERNS: PatternDefinition[] = [
  {
    name: "memory_manipulation",
    pattern: /(?:alter|change|modify|overwrite|delete|rewrite)\s+(?:your|my|the)\s+(?:memory|identity|personality|values|core)\b/i,
    category: "injection",
    severity: "block",
    description: "Attempt to alter the model's memory, identity, or values",
  },
  {
    name: "reveal_system_prompt",
    pattern: /(?:reveal|show|print|output|display|repeat|echo|dump)\s+(?:your|the)\s+(?:full\s+)?(?:system\s+)?(?:prompt|instructions|rules|directives|persona)\b/i,
    category: "injection",
    severity: "block",
    description: "Attempt to extract the system prompt or instructions",
  },
  {
    name: "exfiltrate_secrets",
    pattern: /(?:reveal|show|print|output|dump|leak|list|give\s+me)\s+(?:(?:your|the|my|any|all)\s+)+(?:env(?:ironment)?(?:\s+vars?|\s+variables?)?|api\s*keys?|tokens?|credentials?|secrets?|passwords?|\.env)/i,
    category: "injection",
    severity: "block",
    description: "Attempt to exfiltrate env vars, keys, tokens, or secrets",
  },
  {
    name: "dan_mode",
    pattern: /\bDAN\b.*mode|do\s+anything\s+now(?:\s+mode)?/i,
    category: "injection",
    severity: "block",
    description: "DAN / 'do anything now' jailbreak framing",
  },
  {
    name: "ignore_instructions",
    pattern: /ignore\s+(?:(?:previous|your|all|my)\s+)+(?:instructions|prompt|rules)/i,
    category: "injection",
    severity: "review",
    description: "Instruction-override: 'ignore previous/all instructions'",
  },
  {
    name: "ignore_system_prompt",
    pattern: /ignore\s+(?:your\s+)?system\s+prompt/i,
    category: "injection",
    severity: "review",
    description: "Instruction-override: 'ignore (your) system prompt'",
  },
  {
    name: "forget_everything",
    pattern: /forget\s+everything(?:\s+(?:you|I)\s+(?:know|said))?/i,
    category: "injection",
    severity: "review",
    description: "Context-reset: 'forget everything'",
  },
  {
    name: "new_instructions",
    pattern: /your\s+new\s+instructions?\s+(?:are|is)/i,
    category: "injection",
    severity: "review",
    description: "Instruction-override: 'your new instructions are'",
  },
  {
    name: "disregard",
    pattern: /disregard\s+(?:your|all|previous|any)\s+(?:instructions|prompt|rules|training)/i,
    category: "injection",
    severity: "review",
    description: "Instruction-override: 'disregard your/all instructions'",
  },
  {
    name: "no_restrictions",
    pattern: /act\s+as\s+if\s+you\s+have\s+no\s+(?:restrictions|rules|limits)/i,
    category: "injection",
    severity: "review",
    description: "Boundary-probe: 'act as if you have no restrictions'",
  },
  {
    name: "jailbreak",
    pattern: /\bjailbreak\b|\bbypass\s+(?:(?:your|the|any|all|its)\s+)?(?:safety|filters?|restrictions?|guardrails?)/i,
    category: "injection",
    severity: "review",
    description: "Boundary-probe: jailbreak / bypass safety filters",
  },
  {
    name: "pretend_you_are",
    pattern: /pretend\s+(?:you\s+are|to\s+be)\s+(?!working|busy|done|a\s+helpful)/i,
    category: "injection",
    severity: "warn",
    description: "Roleplay framing: 'pretend you are / to be …'",
  },
  {
    name: "you_are_now",
    pattern: /\byou\s+are\s+now\s+(?:a\s+)?(?!going|about|ready|working|able|doing|past|done|finished|free|here)/i,
    category: "injection",
    severity: "warn",
    description: "Roleplay framing: 'you are now (a) …'",
  },
  // ── Expanded jailbreak / override coverage (H9) ──
  {
    name: "prior_instructions",
    pattern: /(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your)\s+)*prior\s+(?:instructions?|messages?|context|prompts?)/i,
    category: "injection",
    severity: "review",
    description: "Override of 'prior instructions'",
  },
  {
    name: "developer_message",
    pattern: /(?:developer|dev)\s+(?:message|mode|instructions?|note)\s*[:=]?/i,
    category: "injection",
    severity: "review",
    description: "Forged 'developer message' framing",
  },
  {
    name: "system_message_override",
    pattern: /(?:override|replace|update|new)\s+(?:the\s+)?system\s+(?:message|prompt|instructions?)|system\s+message\s+override/i,
    category: "injection",
    severity: "block",
    description: "Attempt to override the system message",
  },
  {
    name: "highest_priority",
    pattern: /(?:this\s+is\s+(?:the\s+)?|with\s+)?highest\s+priority\s*(?:instruction|message|directive|command)?|top\s+priority\s+override/i,
    category: "injection",
    severity: "review",
    description: "Fake authority escalation: 'highest priority'",
  },
  {
    name: "simulation_mode",
    pattern: /\b(?:simulation|developer|debug|sudo|god|admin)\s+mode\b/i,
    category: "injection",
    severity: "review",
    description: "Boundary-probe: special 'mode' framing",
  },
  {
    name: "policy_override",
    pattern: /(?:override|ignore|disable|bypass)\s+(?:the\s+)?(?:content\s+)?policy|policy\s+override/i,
    category: "injection",
    severity: "block",
    description: "Attempt to override content policy",
  },
  {
    name: "hidden_prompt",
    pattern: /\bhidden\s+(?:prompt|instructions?|message|system\s+prompt)\b/i,
    category: "injection",
    severity: "review",
    description: "Reference to a hidden/embedded prompt",
  },
  {
    name: "tool_output_says",
    pattern: /(?:tool|function|api|search)\s+(?:output|result|response)\s+says?\s*[:,]/i,
    category: "injection",
    severity: "review",
    description: "Forged 'tool output says' framing",
  },
  {
    name: "repeat_text_above",
    pattern: /repeat\s+(?:the\s+)?(?:text|words?|everything|content|prompt)\s+(?:above|before|preceding|prior)/i,
    category: "injection",
    severity: "review",
    description: "Prompt-leak probe: 'repeat the text above'",
  },
  {
    name: "encode_secrets",
    pattern: /(?:encode|base64|rot13|hex(?:-?encode)?|obfuscate)\s+(?:(?:the|your|all|any)\s+)*(?:secrets?|keys?|tokens?|credentials?|passwords?|env)/i,
    category: "injection",
    severity: "block",
    description: "Attempt to encode secrets for exfiltration",
  },
  {
    name: "exfiltrate",
    pattern: /\bexfiltrat(?:e|ion|ing)\b/i,
    category: "injection",
    severity: "block",
    description: "Explicit exfiltration intent",
  },
];

// ── PII patterns (global — used with exec for positional capture) ────────────
const PII_PATTERNS: PatternDefinition[] = [
  {
    name: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    category: "pii",
    severity: "review",
    description: "Email address",
  },
  {
    name: "PHONE",
    pattern: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
    category: "pii",
    severity: "review",
    description: "Phone number (US + international)",
  },
  {
    name: "SSN",
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    category: "pii",
    severity: "block",
    description: "US Social Security Number",
  },
  {
    name: "CREDIT_CARD",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    category: "pii",
    severity: "block",
    description: "Credit card number (16 digits)",
  },
  {
    name: "IP_ADDRESS",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    category: "pii",
    severity: "warn",
    description: "IPv4 address",
  },
  {
    name: "NAME",
    pattern: /\b(?:[A-Z][a-z]{1,20}\s){1,2}[A-Z][a-z]{1,20}\b/g,
    category: "pii",
    severity: "warn",
    description: "Person name (consecutive capitalized words)",
  },
];

// ── Policy patterns (non-global — used with test()) ──────────────────────────
const POLICY_PATTERNS: PatternDefinition[] = [
  {
    name: "auth_bypass_allowall",
    pattern: /\b(?:allowAll\s*=\s*true|authenticated\s*=\s*true\s*;|bypassAuth\s*=\s*true|isAdmin\s*=\s*true\s*;)/i,
    category: "policy",
    severity: "review",
    description: "Auth-bypass assignment (allowAll/authenticated/isAdmin = true)",
  },
  {
    name: "disable_security",
    pattern: /\b(?:disableCSRF|disableCORS|rejectUnauthorized\s*:\s*false|strictSSL\s*:\s*false|verify\s*=\s*False|verify_ssl\s*=\s*False)\b/i,
    category: "policy",
    severity: "review",
    description: "Security-disabling configuration",
  },
  {
    name: "dangerous_eval",
    pattern: /\beval\s*\(\s*(?:req|request|body|input|userInput|params|query|msg|message)\b/i,
    category: "policy",
    severity: "review",
    description: "eval() called on user-controlled input",
  },
  {
    name: "env_dump",
    pattern: /JSON\.stringify\s*\(\s*process\.env\b|console\.log\s*\(\s*process\.env\b/i,
    category: "policy",
    severity: "review",
    description: "Dumping process.env",
  },
  {
    name: "skip_auth_comment",
    pattern: /\/\/\s*(?:skip|bypass|remove|disable)\s+auth(?:entication|orization)?\b/i,
    category: "policy",
    severity: "review",
    description: "Comment indicating auth was skipped/bypassed",
  },
];

class VelumPatternRegistry implements PatternRegistry {
  credentialPatterns: PatternDefinition[];
  injectionPatterns: PatternDefinition[];
  piiPatterns: PatternDefinition[];
  policyPatterns: PatternDefinition[];
  neverRedact: Set<string>;

  constructor() {
    // Clone the built-in arrays so mutation never leaks across registries.
    this.credentialPatterns = CREDENTIAL_PATTERNS.map(clonePattern);
    this.injectionPatterns = INJECTION_PATTERNS.map(clonePattern);
    this.piiPatterns = PII_PATTERNS.map(clonePattern);
    this.policyPatterns = POLICY_PATTERNS.map(clonePattern);
    this.neverRedact = new Set(DEFAULT_NEVER_REDACT.map((t) => t.toLowerCase()));
  }

  private bucket(category: PatternCategory): PatternDefinition[] {
    switch (category) {
      case "credential": return this.credentialPatterns;
      case "injection": return this.injectionPatterns;
      case "pii": return this.piiPatterns;
      case "policy": return this.policyPatterns;
    }
  }

  addPattern(def: PatternDefinition): void {
    this.removePattern(def.name);
    // Credential/PII patterns are matched with exec()/match() in a loop; a
    // non-global regex would never advance lastIndex and could hang (H8).
    let pattern = def.pattern;
    if ((def.category === "credential" || def.category === "pii") && !pattern.flags.includes("g")) {
      // eslint-disable-next-line no-console
      console.warn(
        `[velum] pattern '${def.name}' (${def.category}) was missing the 'g' flag; auto-adding it to prevent scan hangs.`,
      );
      pattern = new RegExp(pattern.source, pattern.flags + "g");
    }
    this.bucket(def.category).push(clonePattern({ ...def, pattern }));
  }

  removePattern(name: string): void {
    for (const arr of [
      this.credentialPatterns,
      this.injectionPatterns,
      this.piiPatterns,
      this.policyPatterns,
    ]) {
      const idx = arr.findIndex((p) => p.name === name);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  getPattern(name: string): PatternDefinition | undefined {
    for (const arr of [
      this.credentialPatterns,
      this.injectionPatterns,
      this.piiPatterns,
      this.policyPatterns,
    ]) {
      const found = arr.find((p) => p.name === name);
      if (found) return found;
    }
    return undefined;
  }
}

function clonePattern(def: PatternDefinition): PatternDefinition {
  // Fresh RegExp so global-regex lastIndex state is never shared.
  return {
    name: def.name,
    pattern: new RegExp(def.pattern.source, def.pattern.flags),
    category: def.category,
    severity: def.severity,
    description: def.description,
    confidence: def.confidence,
  };
}

/**
 * Return a global version of `re`, cloning it if the 'g' flag is missing.
 * Used everywhere a regex is driven in an exec()/match() loop so a user-added
 * non-global pattern can never spin forever (H8).
 */
export function ensureGlobal(re: RegExp): RegExp {
  return re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
}

/** Create a fresh, independent pattern registry seeded with all built-ins. */
export function createRegistry(): PatternRegistry {
  return new VelumPatternRegistry();
}

/** The shared default registry used by the core modules. */
export const registry: PatternRegistry = createRegistry();
