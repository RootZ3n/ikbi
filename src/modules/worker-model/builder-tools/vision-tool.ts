/**
 * ikbi builder tool — vision_analyze (multimodal image understanding).
 *
 * Lets a model that can't normally see pixels ask a VISION-capable model about an
 * image: a screenshot of a failing UI, a diagram, a chart, a photo of a whiteboard.
 * Given an image (a LOCAL file under the worktree, or an http(s) URL) and a question,
 * it builds ONE multimodal message — `parts: [{text}, {image_url}]` (the additive
 * ModelMessage.parts seam, provider contract 1.2.0) — invokes the model, and returns
 * the analysis text. A single shot: no tool loop, the model just looks and answers.
 *
 * IMAGE SOURCING:
 *  - LOCAL path → worktree-confined (shared confinePath), read, base64-encoded into a
 *    `data:<mime>;base64,<...>` URL. The MIME comes from the extension; an unsupported
 *    extension is rejected (no silently-wrong mime). We never read outside the worktree.
 *  - REMOTE http(s) URL → passed through verbatim; the PROVIDER fetches it (we do not),
 *    so this adds no egress surface of our own.
 *
 * TRUST: the returned analysis is model output over an UNTRUSTED image → it is fed back
 * through the caller's neutralization chokepoint (vision_analyze is just another tool to
 * the builder/chat). This module only PRODUCES the result string; it never throws past
 * the boundary.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import type { AgentIdentity, ModelMessage, ModelRequest, ModelResponse, ModelTool } from "../../../core/provider/contract.js";
import { adaptMaxTokens, getCapabilities } from "../../../core/provider/capabilities.js";
import { confinePath } from "./confine.js";

/** What vision_analyze needs: a model invoker + the run's identity/model/worktree. */
export interface VisionDeps {
  readonly invokeModel: (request: ModelRequest) => Promise<ModelResponse>;
  readonly identity: AgentIdentity;
  readonly model: string;
  readonly worktreeReal: string;
}

const VISION_TEMPERATURE = 0.2;
const VISION_MAX_TOKENS = 1_024;
/** Cap on a local image we will base64-encode (4 MB raw ≈ ~5.3 MB base64). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Image extensions we can confidently MIME-type for a data-URL. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export const visionAnalyzeTool: ModelTool = {
  name: "vision_analyze",
  description:
    "Analyze an image with a vision-capable model. Provide image_url — a LOCAL file path under the working directory (read + sent inline) or an http(s) URL — and a question about it. Returns the model's analysis. Use for screenshots, diagrams, charts, or photos.",
  parameters: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "A local file path (under the working directory) or an http(s) URL of the image." },
      question: { type: "string", description: "What to ask about the image (e.g. 'what error is shown?', 'describe this diagram')." },
    },
    required: ["image_url", "question"],
  },
};

const VISION_SYSTEM =
  "You are a precise visual analyst. Look at the provided image and answer the question directly and factually. " +
  "Describe only what is actually visible; do not speculate beyond the image. Be concise.";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve the image argument into an `image_url` URL (data-URL for local, passthrough for remote). */
function resolveImageUrl(deps: VisionDeps, imageArg: string): { url: string } | { error: string } {
  if (/^https?:\/\//i.test(imageArg)) {
    return { url: imageArg }; // remote: the provider fetches it
  }
  // Reject other URL-ish schemes (file:, data: smuggling, etc.) — only http(s) or a local path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(imageArg) && !/^[a-z]:[\\/]/i.test(imageArg)) {
    return { error: `vision_analyze: unsupported image source "${imageArg}" (use an http(s) URL or a local file path)` };
  }
  const c = confinePath(deps.worktreeReal, imageArg);
  if (!c.ok) return { error: c.error };
  const ext = extname(c.full).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) {
    return { error: `vision_analyze: unsupported image type "${ext || "(none)"}" — supported: ${Object.keys(MIME_BY_EXT).join(", ")}` };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(c.full);
  } catch (e) {
    return { error: `vision_analyze: could not read image: ${errMsg(e)}` };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { error: `vision_analyze: image is ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES}-byte inline limit` };
  }
  return { url: `data:${mime};base64,${bytes.toString("base64")}` };
}

/** Run a single multimodal vision request and return the analysis string. Never throws past the boundary. */
export async function runVisionAnalyze(deps: VisionDeps, args: Record<string, unknown>): Promise<string> {
  const imageArg = typeof args.image_url === "string" ? args.image_url.trim() : "";
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (imageArg.length === 0) return "ERROR: vision_analyze requires a non-empty 'image_url'";
  if (question.length === 0) return "ERROR: vision_analyze requires a non-empty 'question'";

  const resolved = resolveImageUrl(deps, imageArg);
  if ("error" in resolved) return `ERROR: ${resolved.error}`;

  const caps = getCapabilities(deps.model);
  const maxTokens = adaptMaxTokens(VISION_MAX_TOKENS, caps);

  // ONE multimodal user message: the question (text part) + the image (image_url part).
  // `content` holds the question as the flattened-text fallback; `parts` carries both.
  const messages: ModelMessage[] = [
    { role: "system", content: VISION_SYSTEM },
    {
      role: "user",
      content: question,
      parts: [
        { type: "text", text: question },
        { type: "image_url", image_url: { url: resolved.url } },
      ],
    },
  ];

  try {
    const response = await deps.invokeModel({
      model: deps.model,
      temperature: VISION_TEMPERATURE,
      maxTokens,
      identity: deps.identity,
      messages,
    });
    return response.content.length > 0 ? response.content : "(the vision model returned no text)";
  } catch (e) {
    return `ERROR: vision_analyze model call failed: ${errMsg(e)} (the configured model may not support images)`;
  }
}
