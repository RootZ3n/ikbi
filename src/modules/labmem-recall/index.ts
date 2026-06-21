/**
 * labmem-recall — ikbi's read surface onto labmem, the lab-wide memory system
 * (lab-utilities/lab-memory/labmem). Lets ikbi RECALL shared lab rules, the repo
 * map, cross-agent facts, and its OWN private + project memory.
 *
 * This is DISTINCT from ikbi's internal lab-context-memory module (receipt-
 * projected DocumentStore): that is ikbi's own memory; labmem is the shared
 * lab-wide spine every agent reads.
 *
 * READ-ONLY by design. ikbi proposes durable shared-memory changes through
 * governance, not from here. A pure consumer — it registers no guard and does not
 * touch src/modules/index.ts (operator wires an entrypoint in the barrel pass).
 *
 * We dynamic-import labmem's BUILT dist (ikbi runs compiled `node dist/`), so this
 * works without tsx. A missing/unbuilt labmem yields a clear LabmemUnavailable
 * error rather than crashing the caller.
 */

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** ikbi's labmem namespace. */
export const IKBI_AGENT = "ikbi";

export class LabmemUnavailable extends Error {
  override readonly name = "LabmemUnavailable";
}

/**
 * Portable default labmem root: the in-ecosystem vendored labmem, resolved by
 * walking up to the `ecosystem/` directory so the code ships no absolute lab
 * path. The vendored copy ships CODE only — set LABMEM_ROOT to point at the real
 * mutable memory DATA (the home lab sets it via .env; public installs set their own).
 */
function defaultLabmemRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (basename(d) === "ecosystem") return join(d, "lab-memory", "labmem");
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return join(process.cwd(), "lab-memory", "labmem");
}

/** Resolve the labmem root (env override, else the in-ecosystem vendored labmem). */
export function labmemRoot(): string {
  return process.env["LABMEM_ROOT"] ?? defaultLabmemRoot();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LabmemCore = any;
let _core: LabmemCore | null = null;

async function loadCore(): Promise<LabmemCore> {
  if (_core) return _core;
  const root = labmemRoot();
  try {
    _core = await import(join(root, "dist/index.js"));
  } catch {
    try {
      _core = await import(join(root, "core/index.js"));
    } catch (err) {
      throw new LabmemUnavailable(
        `labmem is not importable at ${root} (build it with \`npm run build\` in labmem/): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return _core;
}

/** Structured recall for ikbi: shared lab memory + ikbi's own private + its project memory. */
export async function recallForIkbi(root: string = labmemRoot()): Promise<{
  shared: unknown[];
  own: unknown[];
  projects: unknown[];
}> {
  const core = await loadCore();
  const r = core.recall(root, IKBI_AGENT);
  return { shared: r.shared, own: r.own, projects: r.projects };
}

/** A compact markdown recall block ikbi can log or fold into a prompt/context. */
export async function renderIkbiRecall(root: string = labmemRoot()): Promise<string> {
  const core = await loadCore();
  return core.renderRecall(core.recall(root, IKBI_AGENT)) as string;
}
