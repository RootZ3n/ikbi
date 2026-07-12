/**
 * abina — geometry utilities for the UI document model.
 *
 * Pure, dependency-free spatial operations on nodes and the document tree:
 * hit testing, bounding boxes, overlap detection, distance measurement.
 *
 * Positions are relative to the immediate parent; absolute (world-space)
 * coordinates require walking the ancestor chain.
 */

import type { Document, Node, Position } from "./types.js";

// ── Exported types ─────────────────────────────────────────────────────────────

/** An axis-aligned bounding rectangle. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// ── Rect helpers ───────────────────────────────────────────────────────────────

/** Build a Rect from a node's own position + size (relative to parent). */
export function getBoundingRect(node: Node): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.size.width,
    height: node.size.height,
  };
}

/** Compute the absolute (world-space) bounding rect of a node in the document. */
export function getAbsoluteRect(node: Node, ancestors?: readonly Node[]): Rect {
  if (!ancestors || ancestors.length === 0) {
    return getBoundingRect(node);
  }

  let absX = node.position.x;
  let absY = node.position.y;

  for (const parent of ancestors) {
    absX += parent.position.x;
    absY += parent.position.y;
  }

  return {
    x: absX,
    y: absY,
    width: node.size.width,
    height: node.size.height,
  };
}

/** Get the center position of a rect. */
export function getCenter(rect: Rect): Position {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

/** Centre of a node's own bounding rect (relative to parent). */
export function getNodeCenter(node: Node): Position {
  return getCenter(getBoundingRect(node));
}

// ── Point / rect tests ─────────────────────────────────────────────────────────

/** Check whether a point falls inside a rect. */
export function isPointInRect(point: Position, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Euclidean distance between two positions. */
export function getDistance(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Rect–rect tests ────────────────────────────────────────────────────────────

/** Check whether rect `a` fully contains rect `b`. */
export function contains(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x &&
    a.y <= b.y &&
    a.x + a.width >= b.x + b.width &&
    a.y + a.height >= b.y + b.height
  );
}

/** Check whether two rects overlap (share any positive area). */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// ── Hit testing ────────────────────────────────────────────────────────────────

/**
 * Find the topmost (last-in-array, i.e. visually highest) node in a forest
 * whose absolute bounding rect contains `point`.
 *
 * Walks recursively into children — the deepest matching descendant wins.
 * Uses absolute positioning by accumulating ancestor offsets.
 *
 * Returns `undefined` if no node matches.
 */
export function hitTest(
  nodes: readonly Node[],
  point: Position,
  ancestors?: readonly Node[],
): Node | undefined {
  // Iterate in reverse (last child is visually topmost / highest z-order)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i] as Node;
    const rect = getAbsoluteRect(node, ancestors);

    if (isPointInRect(point, rect)) {
      // Check children first — a deeper match wins
      const childAncestors = ancestors ? [...ancestors, node] : [node];
      const childHit = hitTest(node.children, point, childAncestors);
      if (childHit !== undefined) {
        return childHit;
      }
      return node;
    }
  }

  return undefined;
}

// ── Document-level bounds ──────────────────────────────────────────────────────

/**
 * Compute the combined bounding box that contains all root-level nodes.
 * Returns `null` when the document has no root nodes.
 */
export function getDocumentBounds(doc: Document): Rect | null {
  const { root } = doc;
  if (root.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of root) {
    const r = getBoundingRect(node);
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// ── Bounds queries ────────────────────────────────────────────────────────────

/** Get the bounding rect of a single node (relative to its parent). */
export function nodeBounds(node: Node): Rect {
  return getBoundingRect(node);
}

/**
 * Compute the combined bounding box of a node and all its descendants.
 * Absolute positioning is used, walking through children recursively.
 */
export function subtreeBounds(node: Node, ancestors?: readonly Node[]): Rect {
  const ownRect = getAbsoluteRect(node, ancestors);

  let minX = ownRect.x;
  let minY = ownRect.y;
  let maxX = ownRect.x + ownRect.width;
  let maxY = ownRect.y + ownRect.height;

  const childAncestors = ancestors ? [...ancestors, node] : [node];

  for (const child of node.children) {
    const childRect = subtreeBounds(child, childAncestors);
    if (childRect.x < minX) minX = childRect.x;
    if (childRect.y < minY) minY = childRect.y;
    if (childRect.x + childRect.width > maxX) maxX = childRect.x + childRect.width;
    if (childRect.y + childRect.height > maxY) maxY = childRect.y + childRect.height;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
