/**
 * abina — node:test tests for geometry utilities.
 *
 * Covers: single leaf node hit test, nested subtree (deepest match),
 * and absent point returning undefined.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contains,
  getAbsoluteRect,
  getBoundingRect,
  getCenter,
  getDistance,
  getDocumentBounds,
  getNodeCenter,
  hitTest,
  isPointInRect,
  overlaps,
} from "./geometry.js";
import { createDocument, createNode } from "./document.js";

import type { Node } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a simple leaf node with known position and size.
 */
function makeLeaf(id: string, x: number, y: number, w: number, h: number): Node {
  return createNode(id, "Text", {
    position: { x, y },
    size: { width: w, height: h },
    content: { type: "Text", text: "" },
  });
}

// ── Single leaf node ───────────────────────────────────────────────────────────

test("hitTest finds a single leaf node at its center", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  const result = hitTest([node], { x: 60, y: 45 });
  assert.notEqual(result, undefined);
  assert.equal(result!.id, "leaf1");
});

test("hitTest finds a single leaf node at its top-left corner", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  const result = hitTest([node], { x: 10, y: 20 });
  assert.notEqual(result, undefined);
  assert.equal(result!.id, "leaf1");
});

test("hitTest finds a single leaf node at its bottom-right corner", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  const result = hitTest([node], { x: 110, y: 70 });
  assert.notEqual(result, undefined);
  assert.equal(result!.id, "leaf1");
});

test("getBoundingRect returns correct rect for a leaf node", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  const rect = getBoundingRect(node);
  assert.deepEqual(rect, { x: 10, y: 20, width: 100, height: 50 });
});

test("getAbsoluteRect returns same as bounding rect for a root-level leaf", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  const rect = getAbsoluteRect(node);
  assert.deepEqual(rect, { x: 10, y: 20, width: 100, height: 50 });
});

test("isPointInRect returns true for a point inside a leaf rect", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  assert.equal(isPointInRect({ x: 60, y: 45 }, getBoundingRect(node)), true);
});

test("isPointInRect returns false for a point outside a leaf rect", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  assert.equal(isPointInRect({ x: 200, y: 200 }, getBoundingRect(node)), false);
});

test("getNodeCenter returns the center of a leaf node", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  assert.deepEqual(getNodeCenter(node), { x: 60, y: 45 });
});

// ── Nested subtree spanning multiple children ──────────────────────────────────

test("hitTest returns the deepest matching child in a nested subtree", () => {
  const grandchild = makeLeaf("gc", 5, 5, 50, 30);
  const child = createNode("child", "Window", {
    position: { x: 100, y: 100 },
    size: { width: 200, height: 150 },
    content: { type: "Window", title: "Child" },
    children: [grandchild],
  });
  const parent = createNode("parent", "Window", {
    position: { x: 0, y: 0 },
    size: { width: 500, height: 400 },
    content: { type: "Window", title: "Parent" },
    children: [child],
  });

  // Point inside grandchild (absolute: x=100+5=105, y=100+5=105)
  const result = hitTest([parent], { x: 105, y: 105 });
  assert.notEqual(result, undefined);
  assert.equal(result!.id, "gc", "Should resolve to the deepest descendant (grandchild)");
});

test("hitTest returns the parent when point is inside parent but outside children", () => {
  const child = makeLeaf("child", 200, 200, 50, 50);
  const parent = createNode("parent", "Window", {
    position: { x: 0, y: 0 },
    size: { width: 500, height: 400 },
    content: { type: "Window", title: "Parent" },
    children: [child],
  });

  // Point inside parent but outside child (child starts at 200,200)
  const result = hitTest([parent], { x: 50, y: 50 });
  assert.notEqual(result, undefined);
  assert.equal(result!.id, "parent", "Should resolve to parent when point misses children");
});

test("hitTest walks multiple nested levels to find deepest match", () => {
  // root -> l1 -> l2 -> leaf (4 levels deep)
  const leaf = makeLeaf("leaf", 0, 0, 30, 20);
  const l2 = createNode("l2", "Card", {
    position: { x: 10, y: 10 },
    size: { width: 100, height: 80 },
    content: { type: "Card", title: "L2" },
    children: [leaf],
  });
  const l1 = createNode("l1", "Window", {
    position: { x: 5, y: 5 },
    size: { width: 200, height: 150 },
    content: { type: "Window", title: "L1" },
    children: [l2],
  });

  // Point inside leaf: abs=(5+10+0=15, 5+10+0=15)
  const result = hitTest([l1], { x: 15, y: 15 });
  assert.notEqual(result, undefined);
  assert.equal(result!.id, "leaf", "Should resolve to the deepest descendant");
});

test("getAbsoluteRect accumulates ancestor offsets for nested nodes", () => {
  const child = makeLeaf("child", 10, 20, 50, 30);
  const parent = createNode("parent", "Window", {
    position: { x: 100, y: 100 },
    size: { width: 200, height: 200 },
    content: { type: "Window", title: "Parent" },
    children: [child],
  });

  const rect = getAbsoluteRect(child, [parent]);
  assert.deepEqual(rect, { x: 110, y: 120, width: 50, height: 30 },
    "Absolute rect should add parent offsets to child position");
});

test("overlaps detects intersecting sibling children", () => {
  const a = makeLeaf("a", 0, 0, 100, 100);
  const b = makeLeaf("b", 50, 50, 100, 100);
  assert.equal(overlaps(getBoundingRect(a), getBoundingRect(b)), true);
});

test("contains detects parent-child nesting", () => {
  const outer = makeLeaf("outer", 0, 0, 200, 200);
  const inner = makeLeaf("inner", 20, 20, 50, 50);
  assert.equal(contains(getBoundingRect(outer), getBoundingRect(inner)), true);
});

test("contains returns false when inner is not fully inside outer", () => {
  const outer = makeLeaf("outer", 0, 0, 100, 100);
  const inner = makeLeaf("inner", 80, 80, 50, 50);
  assert.equal(contains(getBoundingRect(outer), getBoundingRect(inner)), false);
});

test("getDistance computes euclidean distance between two points", () => {
  assert.equal(getDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(getDistance({ x: 1, y: 1 }, { x: 1, y: 1 }), 0);
});

test("getCenter returns center of a rect", () => {
  assert.deepEqual(getCenter({ x: 10, y: 20, width: 100, height: 50 }), { x: 60, y: 45 });
  assert.deepEqual(getCenter({ x: 0, y: 0, width: 0, height: 0 }), { x: 0, y: 0 });
});

// ── Absent point / undefined results ───────────────────────────────────────────

test("hitTest returns undefined for a point outside all nodes", () => {
  const node = makeLeaf("leaf1", 10, 20, 100, 50);
  const result = hitTest([node], { x: 999, y: 999 });
  assert.equal(result, undefined);
});

test("hitTest returns undefined for a point outside all nodes in nested tree", () => {
  const child = makeLeaf("child", 100, 100, 50, 50);
  const parent = createNode("parent", "Window", {
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    content: { type: "Window", title: "Parent" },
    children: [child],
  });

  // Point completely outside the parent
  const result = hitTest([parent], { x: 999, y: 999 });
  assert.equal(result, undefined);
});

test("hitTest returns undefined when point is in a gap between children", () => {
  const childA = makeLeaf("a", 0, 0, 50, 50);
  const childB = makeLeaf("b", 100, 100, 50, 50);
  const parent = createNode("parent", "Window", {
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    content: { type: "Window", title: "Parent" },
    children: [childA, childB],
  });

  // Point inside parent (which covers it) but outside both children
  const result = hitTest([parent], { x: 75, y: 75 });
  assert.notEqual(result, undefined, "Should still hit the parent");
  assert.equal(result!.id, "parent", "Parent is the hit since children are not hit");
});

test("hitTest returns undefined for an empty nodes array", () => {
  const result = hitTest([], { x: 0, y: 0 });
  assert.equal(result, undefined);
});

test("getDocumentBounds returns null for an empty document", () => {
  const doc = createDocument("empty", "Empty");
  const bounds = getDocumentBounds(doc);
  assert.equal(bounds, null);
});

test("getDocumentBounds computes bounds for multiple root nodes", () => {
  const a = makeLeaf("a", 0, 0, 100, 100);
  const b = makeLeaf("b", 200, 150, 50, 50);
  const doc = createDocument("d1", "Doc", [a, b]);
  const bounds = getDocumentBounds(doc);
  assert.notEqual(bounds, null);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 250, height: 200 });
});

test("getDocumentBounds computes bounds for a single node", () => {
  const a = makeLeaf("a", 10, 20, 100, 50);
  const doc = createDocument("d1", "Doc", [a]);
  const bounds = getDocumentBounds(doc);
  assert.notEqual(bounds, null);
  assert.deepEqual(bounds, { x: 10, y: 20, width: 100, height: 50 });
});
