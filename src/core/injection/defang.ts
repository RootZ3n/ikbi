/**
 * ikbi prompt-injection chokepoint — risk-aware primitive defanging.
 *
 * The fence proves delimiter-containment, but fenced-but-intact control tokens
 * (ChatML markers, role tags, transcript role prefixes) can still nudge a model
 * into a role switch. Defanging breaks the literal signal the model keys on by
 * inserting a zero-width break inside the token: the token is no longer the
 * exact control sequence, yet the text stays visually identical and readable, so
 * legitimate content remains usable.
 *
 * Defanging is RISK-AWARE: ON by default for untrusted runtime/external sources,
 * OFF by default for low-risk structured sources (file/repo) where byte accuracy
 * matters. A caller can force it either way via `NeutralizeOptions.defang`.
 *
 * This is lossy by design (it edits matched primitives) — which is why it is only
 * a default for higher-risk sources, and why the lossless path is preserved for
 * file/repo content.
 */

import type { ContentSource } from "./contract.js";

/** Zero-width space inserted to break a control token. Invisible to humans. */
export const DEFANG_BREAK = "\u200B";

/** Sources kept lossless by default (byte accuracy matters; lower injection risk). */
const LOSSLESS_DEFAULT_SOURCES: ReadonlySet<ContentSource> = new Set<ContentSource>(["file", "repo"]);

/**
 * Whether defanging is applied by default for a given source. ON for everything
 * untrusted-and-runtime/external; OFF only for low-risk structured file/repo
 * content. Source-driven so a caller cannot forget to defang a high-risk source.
 */
export function defangByDefault(source: ContentSource): boolean {
  return !LOSSLESS_DEFAULT_SOURCES.has(source);
}

/**
 * Break dangerous prompt primitives in `text` by inserting a zero-width break.
 * Returns the defanged text and the count of primitives neutralized. Patterns are
 * linear (bounded quantifiers) to stay ReDoS-safe.
 */
export function defangPrimitives(text: string): { text: string; count: number } {
  let count = 0;
  const B = DEFANG_BREAK;

  let out = text
    // ChatML / special control tokens: <|im_start|>, <|im_end|>, <|endoftext|>, ...
    .replace(/<\|([^\n|>]{0,60})\|>/g, (_m, inner: string) => {
      count += 1;
      return `<${B}|${inner}|>`;
    })
    // Role tags: <system> </assistant> <user> </tool> <developer>
    .replace(/<(\/?)(system|assistant|user|tool|developer)>/gi, (_m, slash: string, word: string) => {
      count += 1;
      return `<${slash}${B}${word}>`;
    })
    // Llama-style instruction markers: [INST] [/INST]
    .replace(/\[(\/?)INST\]/gi, (_m, slash: string) => {
      count += 1;
      return `[${slash}${B}INST]`;
    })
    // Llama-style system markers: <<SYS>> <</SYS>>
    .replace(/<<(\/?)SYS>>/gi, (_m, slash: string) => {
      count += 1;
      return `<<${slash}${B}SYS>>`;
    });

  // Transcript role prefixes at the start of a line: "SYSTEM:", "ASSISTANT:", ...
  out = out.replace(
    /^([ \t]*)(system|assistant|user|tool|developer)([ \t]*:)/gim,
    (_m, ws: string, word: string, colon: string) => {
      count += 1;
      return `${ws}${word}${B}${colon}`;
    },
  );

  return { text: out, count };
}
