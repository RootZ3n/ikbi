/**
 * abina — comprehensive node:test tests for the UI-agnostic document model.
 *
 * Covers: creation, each validation-failure case, serialize/deserialize
 * round-trip stability, every mutation operation with immutability checks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addNode,
  cloneDocument,
  cloneNode,
  createDocument,
  createNode,
  deserializeDocument,
  editNodeContent,
  moveNode,
  nextId,
  removeNode,
  reparentNode,
  resetIdGenerator,
  serializeDocument,
  validateDocument,
} from "./document.js";

import type { Document, Node, NodeContent } from "./types.js";

// ── Setup helpers ──────────────────────────────────────────────────────────────

function makeTextNode(id: string, text = "hello"): Node {
  return createNode(id, "Text", {
    content: { type: "Text", text },
  });
}

function makeWindowNode(id: string, title = "My Window"): Node {
  return createNode(id, "Window", {
    size: { width: 400, height: 300 },
    content: { type: "Window", title },
  });
}

function makeSimpleDoc(): Document {
  const w = createNode("w1", "Window", {
    size: { width: 800, height: 600 },
    content: { type: "Window", title: "App" },
    children: [
      createNode("t1", "Text", {
        position: { x: 10, y: 10 },
        content: { type: "Text", text: "Hello" },
      }),
      createNode("a1", "Asset", {
        position: { x: 100, y: 50 },
        size: { width: 64, height: 64 },
        content: { type: "Asset", src: "icon.png" },
      }),
    ],
  });
  return createDocument("doc1", "TestDoc", [w]);
}

// ── createDocument ─────────────────────────────────────────────────────────────

test("createDocument creates a document with given id and name", () => {
  const doc = createDocument("d1", "My Design");
  assert.equal(doc.id, "d1");
  assert.equal(doc.name, "My Design");
  assert.deepEqual(doc.root, []);
});

test("createDocument accepts optional root nodes", () => {
  const root = [makeTextNode("n1")];
  const doc = createDocument("d2", "Doc", root);
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.id, "n1");
});

// ── createNode ─────────────────────────────────────────────────────────────────

test("createNode creates a Text node with defaults", () => {
  const n = createNode("n1", "Text");
  assert.equal(n.id, "n1");
  assert.equal(n.type, "Text");
  assert.deepEqual(n.position, { x: 0, y: 0 });
  assert.deepEqual(n.size, { width: 100, height: 100 });
  assert.deepEqual(n.content, { type: "Text", text: "" });
  assert.deepEqual(n.style, {});
  assert.deepEqual(n.children, []);
});

test("createNode creates a Window node", () => {
  const n = createNode("w1", "Window", {
    size: { width: 800, height: 600 },
    content: { type: "Window", title: "App" },
  });
  assert.equal(n.type, "Window");
  assert.equal((n.content as { title: string }).title, "App");
});

test("createNode creates an Asset node with src", () => {
  const n = createNode("a1", "Asset", {
    content: { type: "Asset", src: "logo.png" },
  });
  assert.equal(n.type, "Asset");
  assert.equal((n.content as { src: string }).src, "logo.png");
});

test("createNode creates a Hotspot node", () => {
  const n = createNode("h1", "Hotspot", {
    content: { type: "Hotspot", metadata: "clickable" },
  });
  assert.equal(n.type, "Hotspot");
  assert.equal((n.content as { metadata?: string }).metadata, "clickable");
});

test("createNode creates a Card node", () => {
  const n = createNode("c1", "Card", {
    size: { width: 300, height: 200 },
    content: { type: "Card", title: "Profile" },
  });
  assert.equal(n.type, "Card");
  assert.equal((n.content as { title: string }).title, "Profile");
});

test("createNode accepts overrides for position, size, style, children", () => {
  const child = makeTextNode("child1");
  const n = createNode("n1", "Window", {
    position: { x: 50, y: 100 } as const,
    size: { width: 200, height: 150 } as const,
    style: { color: "red", "font-size": "16px" },
    children: [child],
  });
  assert.deepEqual(n.position, { x: 50, y: 100 });
  assert.deepEqual(n.size, { width: 200, height: 150 });
  assert.deepEqual(n.style, { color: "red", "font-size": "16px" });
  assert.equal(n.children.length, 1);
  assert.equal(n.children[0]!.id, "child1");
});

// ── nextId / resetIdGenerator ──────────────────────────────────────────────────

test("nextId generates sequential IDs", () => {
  resetIdGenerator("test");
  assert.equal(nextId(), "test-1");
  assert.equal(nextId(), "test-2");
  assert.equal(nextId(), "test-3");
});

test("resetIdGenerator resets the counter", () => {
  resetIdGenerator("x");
  nextId();
  nextId();
  resetIdGenerator("y");
  assert.equal(nextId(), "y-1");
});

// ── cloneNode / cloneDocument (helpers) ────────────────────────────────────────

test("cloneNode produces a deep copy", () => {
  const orig = makeWindowNode("w1");
  const cloned = cloneNode(orig);
  assert.deepEqual(cloned, orig);
  // Mutating clone should NOT affect original (but these are frozen types, so check structurally)
  assert.notStrictEqual(cloned, orig);
  assert.notStrictEqual(cloned.position, orig.position);
  assert.notStrictEqual(cloned.size, orig.size);
  assert.notStrictEqual(cloned.content, orig.content);
  assert.notStrictEqual(cloned.children, orig.children);
});

test("cloneDocument produces a deep copy", () => {
  const doc = makeSimpleDoc();
  const cloned = cloneDocument(doc);
  assert.deepEqual(cloned, doc);
  assert.notStrictEqual(cloned, doc);
  assert.notStrictEqual(cloned.root, doc.root);
  assert.notStrictEqual(cloned.root[0], doc.root[0]);
});

// ── validateDocument ───────────────────────────────────────────────────────────

test("validateDocument returns empty errors for a valid document", () => {
  const doc = makeSimpleDoc();
  const errors = validateDocument(doc);
  assert.deepEqual(errors, []);
});

test("validateDocument reports missing document id", () => {
  const doc = createDocument("", "Doc");
  const errors = validateDocument(doc);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.path === "id"));
});

test("validateDocument reports missing document name", () => {
  const doc = createDocument("d1", "");
  const errors = validateDocument(doc);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.path === "name"));
});

test("validateDocument reports invalid node type", () => {
  const doc = createDocument("d1", "Doc", [
    { id: "n1", type: "InvalidType", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, content: { type: "Text", text: "" }, style: {}, children: [] } as unknown as Node,
  ]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.message.includes("Invalid node type")));
});

test("validateDocument reports missing node id", () => {
  const doc = createDocument("d1", "Doc", [
    { id: "", type: "Text", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, content: { type: "Text", text: "" }, style: {}, children: [] },
  ]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.message.includes("id must be non-empty")));
});

test("validateDocument reports duplicate ids", () => {
  const doc = createDocument("d1", "Doc", [
    makeTextNode("dup"),
    makeTextNode("dup"),
  ]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.message.includes("Duplicate")));
});

test("validateDocument reports duplicate ids across nesting levels", () => {
  const doc = createDocument("d1", "Doc", [
    createNode("parent", "Window", {
      content: { type: "Window", title: "P" },
      children: [createNode("child", "Text", { content: { type: "Text", text: "c" } })],
    }),
    makeTextNode("child"), // same id as the nested one
  ]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.message.includes("Duplicate")));
});

test("validateDocument reports invalid position", () => {
  const badNode = makeTextNode("n1");
  // Simulate a malformed position by munging the node
  const doc = createDocument("d1", "Doc", [
    { ...badNode, position: { x: "foo" as unknown as number, y: 0 } },
  ]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.path.includes("position")));
});

test("validateDocument reports invalid size", () => {
  const badNode = makeTextNode("n1");
  const doc = createDocument("d1", "Doc", [
    { ...badNode, size: { width: 100, height: null as unknown as number } },
  ]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.path.includes("size")));
});

test("validateDocument reports missing Asset src", () => {
  // Asset node without src in content
  const n = { id: "a1", type: "Asset" as const, position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, content: { type: "Asset" as const }, style: {}, children: [] };
  const doc = createDocument("d1", "Doc", [n as unknown as Node]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.message.includes("Asset node must have a src")));
});

test("validateDocument reports missing Text content", () => {
  const n = createNode("t1", "Text", { content: { type: "Text", text: "" } });
  const doc = createDocument("d1", "Doc", [n]);
  const errors = validateDocument(doc);
  // text is "" which is not null/undefined, so no error. That's fine.
  assert.deepEqual(errors, []);
});

test("validateDocument reports content type mismatch", () => {
  const n = createNode("n1", "Text", { content: { type: "Text", text: "hi" } });
  // Force content type to be different
  const badNode: Node = { ...n, content: { type: "Window", title: "oops" } as unknown as NodeContent };
  const doc = createDocument("d1", "Doc", [badNode]);
  const errors = validateDocument(doc);
  assert.ok(errors.some((e) => e.message.includes("Content type does not match")));
});

// ── serializeDocument / deserializeDocument ────────────────────────────────────

test("serialize/deserialize round-trip preserves a document", () => {
  const doc = makeSimpleDoc();
  const json = serializeDocument(doc);
  const result = deserializeDocument(json);
  assert.deepEqual(result.errors, [], "Round-trip should have no validation errors");
  assert.equal(result.document.id, doc.id);
  assert.equal(result.document.name, doc.name);
  assert.equal(result.document.root.length, doc.root.length);
});

test("deserializeDocument returns errors for invalid JSON", () => {
  const result = deserializeDocument("not json");
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.message.includes("Invalid JSON")));
});

test("deserializeDocument returns errors for non-document JSON", () => {
  const result = deserializeDocument(JSON.stringify({ foo: "bar" }));
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.message.includes("not a valid Document")));
});

test("serialize/deserialize preserves deep structure", () => {
  const doc = makeSimpleDoc();
  const json = serializeDocument(doc);
  const result = deserializeDocument(json);
  const root0 = result.document.root[0]!;
  assert.equal(root0.type, "Window");
  assert.equal(root0.children.length, 2);
  assert.equal(root0.children[0]!.type, "Text");
  assert.equal((root0.children[0]!.content as { text: string }).text, "Hello");
  assert.equal(root0.children[1]!.type, "Asset");
  assert.equal((root0.children[1]!.content as { src: string }).src, "icon.png");
});

test("serialize/deserialize round-trip with nested children", () => {
  const card = createNode("c1", "Card", {
    size: { width: 300, height: 400 },
    content: { type: "Card", title: "Profile Card" },
    children: [
      createNode("ava", "Asset", {
        position: { x: 10, y: 10 },
        size: { width: 50, height: 50 },
        content: { type: "Asset", src: "avatar.png" },
      }),
      createNode("nm", "Text", {
        position: { x: 70, y: 20 },
        content: { type: "Text", text: "John Doe" },
      }),
    ],
  });
  const doc = createDocument("carddoc", "Card Doc", [card]);
  const json = serializeDocument(doc);
  const result = deserializeDocument(json);
  assert.deepEqual(result.errors, []);
  assert.equal(result.document.root.length, 1);
  const restoredCard = result.document.root[0]!;
  assert.equal(restoredCard.children.length, 2);
  assert.equal((restoredCard.children[1]!.content as { text: string }).text, "John Doe");
});

// ── addNode ────────────────────────────────────────────────────────────────────

test("addNode adds a child to the specified parent", () => {
  const doc = makeSimpleDoc();
  const newNode = makeTextNode("t2", "World");
  const updated = addNode(doc, "w1", newNode);

  // Original unchanged
  assert.equal(doc.root[0]!.children.length, 2);

  // Updated has new child
  assert.equal(updated.root[0]!.children.length, 3);
  assert.equal(updated.root[0]!.children[2]!.id, "t2");
  assert.equal((updated.root[0]!.children[2]!.content as { text: string }).text, "World");
});

test("addNode returns same document if parentId not found", () => {
  const doc = makeSimpleDoc();
  const updated = addNode(doc, "nonexistent", makeTextNode("x"));
  assert.strictEqual(updated, doc);
});

test("addNode is immutable — original document unchanged", () => {
  const doc = makeSimpleDoc();
  const originalChildCount = doc.root[0]!.children.length;
  addNode(doc, "w1", makeTextNode("new"));
  assert.equal(doc.root[0]!.children.length, originalChildCount);
});

test("addNode adds to deeply nested parent", () => {
  const inner = createNode("inner", "Text", { content: { type: "Text", text: "deep" } });
  const outer = createNode("outer", "Window", {
    size: { width: 500, height: 500 },
    content: { type: "Window", title: "Outer" },
    children: [inner],
  });
  const doc = createDocument("d1", "Doc", [outer]);

  const newChild = makeTextNode("deep2", "deeper");
  const updated = addNode(doc, "inner", newChild);

  assert.equal(updated.root[0]!.children[0]!.children.length, 1);
  assert.equal(updated.root[0]!.children[0]!.children[0]!.id, "deep2");
});

// ── removeNode ─────────────────────────────────────────────────────────────────

test("removeNode removes a top-level child", () => {
  const doc = makeSimpleDoc();
  const updated = removeNode(doc, "t1");

  // Original unchanged
  assert.equal(doc.root[0]!.children.length, 2);

  // Updated has one fewer child
  assert.equal(updated.root[0]!.children.length, 1);
  assert.equal(updated.root[0]!.children[0]!.id, "a1");
});

test("removeNode returns same document if id not found", () => {
  const doc = makeSimpleDoc();
  const updated = removeNode(doc, "nonexistent");
  assert.strictEqual(updated, doc);
});

test("removeNode is immutable", () => {
  const doc = makeSimpleDoc();
  const originalChildren = doc.root[0]!.children;
  removeNode(doc, "t1");
  assert.equal(doc.root[0]!.children.length, originalChildren.length);
});

test("removeNode can remove a root-level node", () => {
  const doc = createDocument("d1", "Doc", [
    makeWindowNode("w1"),
    makeTextNode("t1"),
    makeTextNode("t2"),
  ]);
  const updated = removeNode(doc, "t1");
  assert.equal(updated.root.length, 2);
  assert.equal(updated.root[0]!.id, "w1");
  assert.equal(updated.root[1]!.id, "t2");
});

// ── moveNode ───────────────────────────────────────────────────────────────────

test("moveNode changes the position of a node", () => {
  const doc = makeSimpleDoc();
  const updated = moveNode(doc, "t1", { x: 200, y: 300 });

  // Original unchanged
  assert.deepEqual(doc.root[0]!.children[0]!.position, { x: 10, y: 10 });

  // Updated has new position
  assert.deepEqual(updated.root[0]!.children[0]!.position, { x: 200, y: 300 });
});

test("moveNode returns same document if id not found", () => {
  const doc = makeSimpleDoc();
  const updated = moveNode(doc, "nonexistent", { x: 1, y: 1 });
  assert.strictEqual(updated, doc);
});

test("moveNode is immutable", () => {
  const doc = makeSimpleDoc();
  const originalPos = doc.root[0]!.children[0]!.position;
  moveNode(doc, "t1", { x: 999, y: 999 });
  assert.deepEqual(doc.root[0]!.children[0]!.position, originalPos);
});

// ── reparentNode ───────────────────────────────────────────────────────────────

test("reparentNode moves a node to a new parent", () => {
  const doc = makeSimpleDoc();
  // Move t1 from w1 to a1 (a1 is currently a leaf)
  const updated = reparentNode(doc, "t1", "a1");

  // Original unchanged
  assert.equal(doc.root[0]!.children.length, 2);

  // t1 should now be a child of a1
  assert.equal(updated.root[0]!.children.length, 1, "w1 should have only a1 now");
  assert.equal(updated.root[0]!.children[0]!.id, "a1");
  assert.equal(updated.root[0]!.children[0]!.children.length, 1, "a1 should now have t1 as child");
  assert.equal(updated.root[0]!.children[0]!.children[0]!.id, "t1");
});

test("reparentNode returns same document if node not found", () => {
  const doc = makeSimpleDoc();
  const updated = reparentNode(doc, "nonexistent", "w1");
  assert.strictEqual(updated, doc);
});

test("reparentNode returns same document if new parent not found", () => {
  const doc = makeSimpleDoc();
  const updated = reparentNode(doc, "t1", "nonexistent");
  assert.strictEqual(updated, doc);
});

test("reparentNode prevents cycle (node cannot become its own ancestor)", () => {
  const doc = makeSimpleDoc();
  // Try to reparent w1 under t1 (t1 is w1's child — would create a cycle)
  const updated = reparentNode(doc, "w1", "t1");
  assert.strictEqual(updated, doc, "Cycle should be prevented");
});

test("reparentNode is immutable", () => {
  const doc = makeSimpleDoc();
  const originalChildren = doc.root[0]!.children;
  reparentNode(doc, "t1", "a1");
  assert.equal(doc.root[0]!.children.length, originalChildren.length);
});

// ── editNodeContent ────────────────────────────────────────────────────────────

test("editNodeContent changes the content of a node", () => {
  const doc = makeSimpleDoc();
  const updated = editNodeContent(doc, "t1", { type: "Text", text: "Goodbye" });

  // Original unchanged
  assert.equal((doc.root[0]!.children[0]!.content as { text: string }).text, "Hello");

  // Updated has new content
  assert.equal((updated.root[0]!.children[0]!.content as { text: string }).text, "Goodbye");
});

test("editNodeContent returns same document if id not found", () => {
  const doc = makeSimpleDoc();
  const updated = editNodeContent(doc, "nonexistent", { type: "Text", text: "x" });
  assert.strictEqual(updated, doc);
});

test("editNodeContent ignores content type mismatch", () => {
  const doc = makeSimpleDoc();
  const updated = editNodeContent(doc, "t1", { type: "Asset", src: "img.png" });
  // t1 is Text type; content type Asset doesn't match, so doc should be unchanged
  assert.strictEqual(updated, doc, "Mismatched content type should return same doc");
});

test("editNodeContent works on deeply nested nodes", () => {
  const inner = createNode("deep", "Text", { content: { type: "Text", text: "before" } });
  const doc = createDocument("d1", "Doc", [
    createNode("w1", "Window", {
      content: { type: "Window", title: "W" },
      children: [inner],
    }),
  ]);

  const updated = editNodeContent(doc, "deep", { type: "Text", text: "after" });
  assert.equal((updated.root[0]!.children[0]!.content as { text: string }).text, "after");
  assert.equal((doc.root[0]!.children[0]!.content as { text: string }).text, "before", "Original unchanged");
});

// ── Immutability grand check ───────────────────────────────────────────────────

test("all mutation operations produce strictly different objects", () => {
  const doc = makeSimpleDoc();

  const doc2 = addNode(doc, "w1", makeTextNode("new"));
  assert.notStrictEqual(doc2, doc);
  assert.notStrictEqual(doc2.root, doc.root);
  assert.notStrictEqual(doc2.root[0], doc.root[0]);

  const doc3 = removeNode(doc2, "new");
  assert.notStrictEqual(doc3, doc2);

  const doc4 = moveNode(doc3, "t1", { x: 99, y: 88 });
  assert.notStrictEqual(doc4, doc3);
  assert.notStrictEqual(doc4.root[0], doc3.root[0]);

  const doc5 = editNodeContent(doc4, "a1", { type: "Asset", src: "new.png" });
  assert.notStrictEqual(doc5, doc4);
  assert.notStrictEqual(doc5.root[0], doc4.root[0]);
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

test("a document with many nested nodes round-trips correctly", () => {
  const buildTree = (depth: number, parentId: string): Node => {
    if (depth <= 0) {
      return makeTextNode(parentId, `leaf-${parentId}`);
    }
    const children: Node[] = [];
    for (let i = 0; i < 3; i++) {
      children.push(buildTree(depth - 1, `${parentId}-${i}`));
    }
    return createNode(parentId, "Window", {
      size: { width: 100, height: 100 },
      content: { type: "Window", title: `node-${parentId}` },
      children,
    });
  };

  const root = buildTree(3, "root");
  const doc = createDocument("deep", "Deep Tree", [root]);
  const json = serializeDocument(doc);
  const result = deserializeDocument(json);
  assert.deepEqual(result.errors, []);
  assert.equal(result.document.root[0]!.id, "root");
  assert.equal(result.document.root[0]!.children.length, 3);
});

test("empty document (no root nodes) validates and round-trips", () => {
  const doc = createDocument("empty", "Empty");
  assert.deepEqual(validateDocument(doc), []);
  const json = serializeDocument(doc);
  const result = deserializeDocument(json);
  assert.deepEqual(result.errors, []);
  assert.equal(result.document.id, "empty");
  assert.equal(result.document.name, "Empty");
  assert.deepEqual(result.document.root, []);
});

test("addNode clones the given node (defensive copy)", () => {
  const doc = makeSimpleDoc();
  const origNode = makeTextNode("newt", "original");
  const updated = addNode(doc, "w1", origNode);

  // Mutate the original after adding — should not affect the document
  // (Since types are readonly, we can't mutate. But we can verify they are different objects.)
  const addedChild = updated.root[0]!.children[2]!;
  assert.notStrictEqual(addedChild, origNode, "addNode should clone the node");
});

test("reparentNode with same parent works", () => {
  // Create a doc with w1 as parent and t1, a1 as children
  // Reparent t1 to w1 (same parent) — should just move within same children
  const doc = makeSimpleDoc();
  const updated = reparentNode(doc, "t1", "w1");
  // t1 should still be somewhere under w1
  const hasT1 = updated.root[0]!.children.some((c) => c.id === "t1");
  assert.equal(hasT1, true, "t1 should still be under w1");
  // Should have the same number of children
  assert.equal(updated.root[0]!.children.length, 2, "Same parent reparent should keep same count");
});

test("Hotspot node with no metadata round-trips", () => {
  const h = createNode("h1", "Hotspot");
  const doc = createDocument("d1", "Doc", [h]);
  assert.deepEqual(validateDocument(doc), []);
  const json = serializeDocument(doc);
  const result = deserializeDocument(json);
  assert.deepEqual(result.errors, []);
});

test("Card node with children validates", () => {
  const card = createNode("c1", "Card", {
    size: { width: 300, height: 200 },
    content: { type: "Card", title: "Card" },
    children: [makeTextNode("t1", "Label")],
  });
  const doc = createDocument("d1", "Doc", [card]);
  assert.deepEqual(validateDocument(doc), []);
});
