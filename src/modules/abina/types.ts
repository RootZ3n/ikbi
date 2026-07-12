/**
 * abina — UI-agnostic document model types for a UI design tool.
 *
 * A document is a tree of typed nodes. Every node has common fields
 * (id, type, position, size, style, children) plus a type-specific `content`
 * payload. Mutation is always immutable: every operation returns a new document.
 */

// ── Primitives ────────────────────────────────────────────────────────────────

export type NodeType = "Window" | "Card" | "Asset" | "Hotspot" | "Text";

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** CSS-like key/value pairs for node styling. */
export type StyleMap = Readonly<Record<string, string>>;

// ── Type-specific content ──────────────────────────────────────────────────────

export interface WindowContent {
  readonly title?: string;
}

export interface CardContent {
  readonly title?: string;
}

export interface AssetContent {
  readonly src: string;
}

export interface HotspotContent {
  readonly metadata?: string;
}

export interface TextContent {
  readonly text: string;
}

/** Discriminated union of all node-content shapes, keyed by `type`. */
export type NodeContent =
  | ({ type: "Window" } & WindowContent)
  | ({ type: "Card" } & CardContent)
  | ({ type: "Asset" } & AssetContent)
  | ({ type: "Hotspot" } & HotspotContent)
  | ({ type: "Text" } & TextContent);

// ── Node ───────────────────────────────────────────────────────────────────────

export interface Node {
  readonly id: string;
  readonly type: NodeType;
  readonly position: Position;
  readonly size: Size;
  readonly content: NodeContent;
  readonly style: StyleMap;
  readonly children: readonly Node[];
}

// ── Document ───────────────────────────────────────────────────────────────────

export interface Document {
  readonly id: string;
  readonly name: string;
  readonly root: readonly Node[];
}
