/**
 * import-html — parse a minimal subset of HTML into the abina document model.
 *
 * Supports: div, section, span, p, img tags with style attributes.
 * Mapping:  div -> Card, section -> Window, img -> Asset, span/p -> Text,
 *           any element with data-hotspot -> Hotspot.
 *
 * Pure TypeScript, no DOM library, no external dependencies.
 */

import {
  createDocument,
  createNode,
} from "./index.js";

import type {
  Document,
  Node,
  StyleMap,
} from "./index.js";

// ── Internal HTML-tree types ──────────────────────────────────────────────────

interface HtmlElement {
  readonly tag: string;
  readonly attributes: Record<string, string>;
  readonly children: readonly (HtmlElement | string)[];
}

// ── Style parser ──────────────────────────────────────────────────────────────

/**
 * Parse a CSS style attribute string into a StyleMap.
 * Example: "color: red; font-size: 16px" -> { color: "red", "font-size": "16px" }
 */
export function parseStyleString(style: string): StyleMap {
  const result: Record<string, string> = {};
  if (!style) return result;

  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}

// ── Minimal HTML parser ───────────────────────────────────────────────────────

/**
 * Parse a minimal subset of HTML into an intermediate tree.
 * Handles: div, section, span, p, img, and arbitrary nested tags.
 * Attributes are case-normalised to lowercase keys.
 */
function parseHtml(html: string): HtmlElement[] {
  const roots: HtmlElement[] = [];
  const stack: HtmlElement[] = [];
  let pos = 0;
  let textAcc = "";

  function flushText(target: (HtmlElement | string)[]) {
    const t = textAcc;
    textAcc = "";
    if (t.trim()) {
      target.push(t);
    }
  }

  while (pos < html.length) {
    const c = html[pos];

    if (c === "<") {
      // Check for comment
      if (html.startsWith("<!--", pos)) {
        const end = html.indexOf("-->", pos + 4);
        pos = end !== -1 ? end + 3 : html.length;
        continue;
      }

      const closeIdx = html.indexOf(">", pos);
      if (closeIdx === -1) {
        textAcc += html.slice(pos);
        break;
      }

      const tagRaw = html.slice(pos + 1, closeIdx);
      pos = closeIdx + 1;

      // Self-closing or closing tag
      if (tagRaw.startsWith("/")) {
        const tagName = tagRaw.slice(1).trim().toLowerCase();
        // Flush any buffered text into the current context
        if (stack.length > 0) {
          const current = stack[stack.length - 1]!;
          flushText(current.children as (HtmlElement | string)[]);
        } else {
          flushText(roots as unknown as (HtmlElement | string)[]);
        }
        // Pop stack until we find matching tag
        while (stack.length > 0) {
          const top = stack.pop()!;
          if (top.tag === tagName) break;
        }
        continue;
      }

      if (tagRaw.endsWith("/")) {
        // Self-closing tag like <img />
        const inner = tagRaw.slice(0, -1).trim();
        const [namePart, ...attrParts] = inner.split(/\s+/);
        const tagName = namePart!.toLowerCase();
        const attrStr = attrParts.join(" ");
        const attrs = parseAttributes(attrStr);
        const elem: HtmlElement = { tag: tagName, attributes: attrs, children: [] };

        if (stack.length > 0) {
          flushText(stack[stack.length - 1]!.children as (HtmlElement | string)[]);
          (stack[stack.length - 1]!.children as (HtmlElement | string)[]).push(elem);
        } else {
          flushText(roots as unknown as (HtmlElement | string)[]);
          roots.push(elem);
        }
        continue;
      }

      // Opening tag
      const trimmed = tagRaw.trim();
      const spaceIdx = trimmed.search(/[\s\/]/);
      let tagName: string;
      let attrStr: string;

      if (spaceIdx === -1) {
        tagName = trimmed.toLowerCase();
        attrStr = "";
      } else {
        tagName = trimmed.slice(0, spaceIdx).toLowerCase();
        attrStr = trimmed.slice(spaceIdx + 1).trim();
      }

      const attrs = parseAttributes(attrStr);

      // Flush text into current context before opening a new element
      if (stack.length > 0) {
        flushText(stack[stack.length - 1]!.children as (HtmlElement | string)[]);
      } else {
        flushText(roots as unknown as (HtmlElement | string)[]);
      }

      const elem: HtmlElement = { tag: tagName, attributes: attrs, children: [] };

      // Self-closing tags
      if (tagName === "img" || tagName === "br" || tagName === "hr" || tagName === "input") {
        if (stack.length > 0) {
          (stack[stack.length - 1]!.children as (HtmlElement | string)[]).push(elem);
        } else {
          roots.push(elem);
        }
      } else {
        if (stack.length > 0) {
          (stack[stack.length - 1]!.children as (HtmlElement | string)[]).push(elem);
        } else {
          roots.push(elem);
        }
        stack.push(elem);
      }
    } else {
      textAcc += c;
      pos++;
    }
  }

  // Flush remaining text
  if (textAcc.trim()) {
    if (stack.length > 0) {
      (stack[stack.length - 1]!.children as (HtmlElement | string)[]).push(textAcc);
    } else {
      roots.push({ tag: "#text", attributes: {}, children: [textAcc] });
    }
  }

  return roots;
}

/**
 * Parse a string of HTML attributes into a key-value map.
 * Supports single-quoted, double-quoted, and unquoted values.
 */
function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrStr.trim()) return attrs;

  // Match attribute name=value or just name
  const attrRe = /([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrStr)) !== null) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = value;
  }

  return attrs;
}

// ── Extract text content from mixed children ──────────────────────────────────

/**
 * Recursively extract all text from an element's children.
 */
function extractText(children: readonly (HtmlElement | string)[]): string {
  let result = "";
  for (const child of children) {
    if (typeof child === "string") {
      result += child;
    } else {
      result += extractText(child.children);
    }
  }
  return result;
}

// ── Convert HTML tree to abina nodes ──────────────────────────────────────────

let idCounter = 0;

/** Reset the internal ID counter (useful in tests). */
export function resetHtmlIdCounter(): void {
  idCounter = 0;
}

/**
 * Convert an HtmlElement into an abina Node, recursively processing children.
 */
function htmlElementToNode(element: HtmlElement): Node | null {
  const { tag, attributes, children } = element;

  // Ignore virtual text-only elements from our parser
  if (tag === "#text") {
    return null;
  }

  const style = parseStyleString(attributes["style"] ?? "");
  const nodeId = `html-${++idCounter}`;

  // data-hotspot takes priority over tag type
  if ("data-hotspot" in attributes) {
    const childNodes = convertChildren(children);
    return createNode(nodeId, "Hotspot", {
      content: { type: "Hotspot", metadata: attributes["data-hotspot"] ?? "" },
      style,
      children: childNodes,
    });
  }

  // Map tags to node types
  switch (tag) {
    case "section": {
      const childNodes = convertChildren(children);
      return createNode(nodeId, "Window", {
        size: { width: 800, height: 600 },
        content: { type: "Window", title: attributes["title"] ?? "Window" },
        style,
        children: childNodes,
      });
    }

    case "div": {
      const childNodes = convertChildren(children);
      return createNode(nodeId, "Card", {
        size: { width: 400, height: 300 },
        content: { type: "Card", title: attributes["title"] ?? "Card" },
        style,
        children: childNodes,
      });
    }

    case "img": {
      return createNode(nodeId, "Asset", {
        size: { width: 100, height: 100 },
        content: { type: "Asset", src: attributes["src"] ?? "" },
        style,
      });
    }

    case "span":
    case "p": {
      const text = extractText(children);
      return createNode(nodeId, "Text", {
        content: { type: "Text", text },
        style,
      });
    }

    default: {
      // Unknown tag: treat as a Card if it has children, or Text if it has text
      const childNodes = convertChildren(children);
      const text = extractText(children);

      if (childNodes.length > 0) {
        return createNode(nodeId, "Card", {
          size: { width: 400, height: 300 },
          content: { type: "Card", title: attributes["title"] ?? tag },
          style,
          children: childNodes,
        });
      }

      if (text.trim()) {
        return createNode(nodeId, "Text", {
          content: { type: "Text", text: text.trim() },
          style,
        });
      }

      return null;
    }
  }
}

/**
 * Convert a list of HtmlElement children into abina Nodes.
 * Interleaved text strings become Text nodes.
 */
function convertChildren(
  children: readonly (HtmlElement | string)[],
): readonly Node[] {
  const nodes: Node[] = [];

  for (const child of children) {
    if (typeof child === "string") {
      const trimmed = child.trim();
      if (trimmed) {
        const nodeId = `html-${++idCounter}`;
        nodes.push(
          createNode(nodeId, "Text", {
            content: { type: "Text", text: trimmed },
          }),
        );
      }
    } else {
      const node = htmlElementToNode(child);
      if (node !== null) {
        nodes.push(node);
      }
    }
  }

  return nodes;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Parse a minimal subset of HTML into an abina Document.
 *
 * Supported tags:
 *   - div   -> Card
 *   - section -> Window
 *   - img   -> Asset (src from the src attribute)
 *   - span  -> Text
 *   - p     -> Text
 *   - any element with `data-hotspot` attribute -> Hotspot
 *
 * Nested elements produce a tree of child nodes. The `style` attribute is
 * parsed into a StyleMap. Unknown tags are mapped to Card (if they have
 * children) or Text (if they have text content).
 *
 * @param html     The HTML string to parse.
 * @param docName  The name for the resulting Document.
 * @returns An abina Document.
 */
export function parseHtmlToDocument(html: string, docName: string): Document {
  // Reset the ID counter so each call produces deterministic IDs
  // for the same input (pure function property).
  idCounter = 0;

  const elements = parseHtml(html);
  const rootNodes = convertChildren(elements);

  // Create document with a stable id based on docName
  const docId = docName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "doc";

  return createDocument(docId, docName, rootNodes);
}
