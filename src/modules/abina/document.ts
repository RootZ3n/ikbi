/**
 * abina — immutable document model for a UI design tool.
 *
 * Every mutator returns a NEW document (deep-ish copy) and never mutates
 * its inputs. Nodes are found/updated by walking the tree recursively.
 */

import type {
  AssetContent,
  CardContent,
  Document,
  HotspotContent,
  Node,
  NodeContent,
  NodeType,
  Position,
  Size,
  StyleMap,
  TextContent,
  WindowContent,
} from "./types.js";

// ── Identity ───────────────────────────────────────────────────────────────────

let idCounter = 0;
let idPrefix = "abina";

/**
 * Reset the internal ID counter (useful in tests for deterministic IDs).
 * Pass `prefix` to set a new prefix for subsequent IDs.
 */
export function resetIdGenerator(prefix = "abina"): void {
  idCounter = 0;
  idPrefix = prefix;
}

/** Generate a unique-ish string ID. Deterministic if reset before use. */
export function nextId(): string {
  return `${idPrefix}-${++idCounter}`;
}

// ── Factory helpers ────────────────────────────────────────────────────────────

const DEFAULT_SIZE: Size = { width: 100, height: 100 } as const;
const DEFAULT_POSITION: Position = { x: 0, y: 0 } as const;
const DEFAULT_STYLE: StyleMap = {} as const;

/**
 * Create a typed content payload for the given node type.
 * Throws if content is invalid for the type.
 */
function makeContent(type: NodeType, content?: Partial<NodeContent>): NodeContent {
  switch (type) {
    case "Window":
      return { type: "Window", title: (content as WindowContent | undefined)?.title ?? "Window" };
    case "Card":
      return { type: "Card", title: (content as CardContent | undefined)?.title ?? "Card" };
    case "Asset":
      return { type: "Asset", src: (content as AssetContent | undefined)?.src ?? "" };
    case "Hotspot":
      const hContent = content as HotspotContent | undefined;
      return (hContent?.metadata !== undefined) ? { type: "Hotspot", metadata: hContent.metadata } as NodeContent : { type: "Hotspot" } as NodeContent;
    case "Text":
      return { type: "Text", text: (content as TextContent | undefined)?.text ?? "" };
  }
}

// ── Deep-clone helpers ─────────────────────────────────────────────────────────

/** Recursively clone a node (deep copy). */
export function cloneNode(node: Node): Node {
  return {
    ...node,
    position: { ...node.position },
    size: { ...node.size },
    style: { ...node.style },
    content: { ...node.content } as NodeContent,
    children: node.children.map(cloneNode),
  };
}

/** Clone a document (deep copy of root array + each node). */
export function cloneDocument(doc: Document): Document {
  return {
    ...doc,
    root: doc.root.map(cloneNode),
  };
}

// ── createDocument ─────────────────────────────────────────────────────────────

export function createDocument(id: string, name: string, root?: readonly Node[]): Document {
  return {
    id,
    name,
    root: root ?? [],
  };
}

// ── createNode ─────────────────────────────────────────────────────────────────

export function createNode(
  id: string,
  type: NodeType,
  overrides?: {
    position?: Partial<Position>;
    size?: Partial<Size>;
    content?: Partial<NodeContent>;
    style?: StyleMap;
    children?: readonly Node[];
  },
): Node {
  return {
    id,
    type,
    position: { x: overrides?.position?.x ?? DEFAULT_POSITION.x, y: overrides?.position?.y ?? DEFAULT_POSITION.y },
    size: { width: overrides?.size?.width ?? DEFAULT_SIZE.width, height: overrides?.size?.height ?? DEFAULT_SIZE.height },
    content: makeContent(type, overrides?.content),
    style: overrides?.style ?? DEFAULT_STYLE,
    children: overrides?.children ?? [],
  };
}

// ── Tree walking helpers ───────────────────────────────────────────────────────

/**
 * Find a node by id within a forest of nodes.
 * Returns the node (a reference) and its path indices for reconstruction,
 * or `undefined` if not found.
 */
function findNode(
  nodes: readonly Node[],
  id: string,
): { node: Node; path: number[] } | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Node;
    if (n.id === id) {
      return { node: n, path: [i] };
    }
    const found = findNode(n.children, id);
    if (found !== undefined) {
      return { node: found.node, path: [i, ...found.path] };
    }
  }
  return undefined;
}

/**
 * Update a node at a given path by applying `update` to it.
 * Returns a new forest (shallow copies along the path, leaves are cloned).
 */
function updateAtPath(
  nodes: readonly Node[],
  path: number[],
  update: (node: Node) => Node,
): Node[] {
  if (path.length === 0) {
    // No more path — shouldn't happen with valid paths.
    return [...nodes];
  }

  const [head, ...rest] = path;
  const idx = head as number;

  return nodes.map((n, i) => {
    if (i !== idx) return n;
    if (rest.length === 0) {
      return update(cloneNode(n));
    }
    return {
      ...n,
      children: updateAtPath(n.children, rest, update),
    } as Node;
  });
}

/**
 * Remove a node at a given path from the forest.
 * Returns a new forest without that node.
 */
function removeAtPath(
  nodes: readonly Node[],
  path: number[],
): Node[] {
  if (path.length === 0) return [...nodes];

  const [head, ...rest] = path;
  const idx = head as number;

  return nodes.flatMap((n, i) => {
    if (i !== idx) return [n];
    if (rest.length === 0) {
      // This is the node to delete
      return [];
    }
    return [{
      ...n,
      children: removeAtPath(n.children, rest),
    } as Node];
  });
}

// ── validateDocument ───────────────────────────────────────────────────────────

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

/**
 * Validate a document tree and return an array of errors.
 * Returns an empty array if the document is valid.
 */
export function validateDocument(doc: Document): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!doc.id) {
    errors.push({ path: "id", message: "Document id must be non-empty" });
  }
  if (!doc.name) {
    errors.push({ path: "name", message: "Document name must be non-empty" });
  }
  if (!Array.isArray(doc.root)) {
    errors.push({ path: "root", message: "Document root must be an array" });
    // Can't validate children if root is not an array
    return errors;
  }

  const seenIds = new Set<string>();

  function validateNode(node: Node, parentPath: string): void {
    const nodePath = parentPath ? `${parentPath} > ${node.id}` : node.id;

    if (!node.id) {
      errors.push({ path: nodePath, message: "Node id must be non-empty" });
    } else if (seenIds.has(node.id)) {
      errors.push({ path: nodePath, message: `Duplicate node id: ${node.id}` });
    } else {
      seenIds.add(node.id);
    }

    if (!node.type) {
      errors.push({ path: nodePath, message: "Node type must be non-empty" });
    } else {
      const validTypes: NodeType[] = ["Window", "Card", "Asset", "Hotspot", "Text"];
      if (!validTypes.includes(node.type)) {
        errors.push({ path: nodePath, message: `Invalid node type: ${node.type}` });
      }
    }

    if (node.position == null || typeof node.position.x !== "number" || typeof node.position.y !== "number") {
      errors.push({ path: `${nodePath}.position`, message: "Node position must contain x and y numbers" });
    }

    if (node.size == null || typeof node.size.width !== "number" || typeof node.size.height !== "number") {
      errors.push({ path: `${nodePath}.size`, message: "Node size must contain width and height numbers" });
    }

    // Validate type-specific content
    if (node.type === "Asset") {
      const c = node.content as { src?: string };
      if (!c.src && c.src !== "") {
        errors.push({ path: `${nodePath}.content.src`, message: "Asset node must have a src" });
      }
    }
    if (node.type === "Text") {
      const c = node.content as { text?: string };
      if (c.text === undefined || c.text === null) {
        errors.push({ path: `${nodePath}.content.text`, message: "Text node must have text content" });
      }
    }
    // type mismatch check
    if (node.content && (node.content as { type?: string }).type && (node.content as { type?: string }).type !== node.type) {
      errors.push({ path: `${nodePath}.content.type`, message: "Content type does not match node type" });
    }

    if (!Array.isArray(node.children)) {
      errors.push({ path: `${nodePath}.children`, message: "Node children must be an array" });
    } else {
      for (const child of node.children) {
        validateNode(child, nodePath);
      }
    }
  }

  for (const node of doc.root) {
    validateNode(node, "root");
  }

  return errors;
}

// ── serializeDocument ──────────────────────────────────────────────────────────

/** Serialize a document to a JSON string. */
export function serializeDocument(doc: Document): string {
  return JSON.stringify(doc, null, 2);
}

// ── deserializeDocument ────────────────────────────────────────────────────────

/** Parse a JSON string and validate the result into a Document. */
export function deserializeDocument(json: string): { document: Document; errors: ValidationError[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { document: createDocument("", ""), errors: [{ path: "", message: "Invalid JSON" }] };
  }

  const doc = parsed as Document;

  // Basic shape check
  if (!doc || typeof doc !== "object" || typeof doc.id !== "string" || typeof doc.name !== "string" || !Array.isArray(doc.root)) {
    return { document: createDocument("", ""), errors: [{ path: "", message: "JSON is not a valid Document shape" }] };
  }

  const errors = validateDocument(doc);
  return { document: doc, errors };
}

// ── addNode ────────────────────────────────────────────────────────────────────

/**
 * Add a child node to the node identified by `parentId`.
 * Returns a new document; the original is untouched.
 * If parentId is not found, the document is returned unchanged.
 */
export function addNode(doc: Document, parentId: string, node: Node): Document {
  const pathInfo = findNode(doc.root, parentId);
  if (pathInfo === undefined) {
    return doc;
  }

  const newRoot = updateAtPath(doc.root, pathInfo.path, (parent) => ({
    ...parent,
    children: [...parent.children, cloneNode(node)],
  }));

  return { ...doc, root: newRoot };
}

// ── removeNode ─────────────────────────────────────────────────────────────────

/**
 * Remove a node identified by `id` from the document tree.
 * Returns a new document; the original is untouched.
 * If the node is not found, the document is returned unchanged.
 */
export function removeNode(doc: Document, id: string): Document {
  const pathInfo = findNode(doc.root, id);
  if (pathInfo === undefined) {
    return doc;
  }

  const newRoot = removeAtPath(doc.root, pathInfo.path);
  return { ...doc, root: newRoot };
}

// ── moveNode ───────────────────────────────────────────────────────────────────

/**
 * Change the position (x, y) of a node identified by `id`.
 * Returns a new document; the original is untouched.
 * If the node is not found, the document is returned unchanged.
 */
export function moveNode(doc: Document, id: string, newPosition: Position): Document {
  const pathInfo = findNode(doc.root, id);
  if (pathInfo === undefined) {
    return doc;
  }

  const newRoot = updateAtPath(doc.root, pathInfo.path, (node) => ({
    ...node,
    position: { ...node.position, ...newPosition },
  }));

  return { ...doc, root: newRoot };
}

// ── reparentNode ───────────────────────────────────────────────────────────────

/**
 * Move a node from its current parent to a new parent identified by `newParentId`.
 * Returns a new document; the original is untouched.
 * If the node or new parent is not found, or if reparenting would create a cycle,
 * the document is returned unchanged.
 */
export function reparentNode(doc: Document, id: string, newParentId: string): Document {
  // Find both the node and its new parent
  const nodeInfo = findNode(doc.root, id);
  const newParentInfo = findNode(doc.root, newParentId);

  if (nodeInfo === undefined || newParentInfo === undefined) {
    return doc;
  }

  // Prevent cycle: new parent cannot be a descendant of the node being moved
  const node = nodeInfo.node;
  const descendantInfo = findNode(node.children, newParentId);
  if (descendantInfo !== undefined) {
    return doc;
  }

  // Remove the node from its current position, then add it to the new parent
  const afterRemove = removeAtPath(doc.root, nodeInfo.path);
  // After removal, the new parent's path may have shifted. Re-find it.
  const newParentInfoAfterRemove = findNode(afterRemove, newParentId);
  if (newParentInfoAfterRemove === undefined) {
    // Shouldn't happen, but be safe
    return doc;
  }

  const newRoot = updateAtPath(afterRemove, newParentInfoAfterRemove.path, (parent) => ({
    ...parent,
    children: [...parent.children, cloneNode(node)],
  }));

  return { ...doc, root: newRoot };
}

// ── editNodeContent ────────────────────────────────────────────────────────────

/**
 * Replace the content of a node identified by `id`.
 * The content must match the node's type (checked at runtime).
 * Returns a new document; the original is untouched.
 * If the node is not found, the document is returned unchanged.
 */
export function editNodeContent(doc: Document, id: string, content: NodeContent): Document {
  const pathInfo = findNode(doc.root, id);
  if (pathInfo === undefined) {
    return doc;
  }

  const node = pathInfo.node;

  // Type-check the new content
  if (content.type !== node.type) {
    // Silently return unchanged — content type must match node type
    return doc;
  }

  const newRoot = updateAtPath(doc.root, pathInfo.path, (n) => ({
    ...n,
    content: { ...content } as NodeContent,
  }));

  return { ...doc, root: newRoot };
}
