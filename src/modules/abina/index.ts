/**
 * abina — UI-agnostic document model for a UI design tool.
 *
 * Pure, immutable document tree: every mutator returns a NEW document.
 *
 * @status dormant (library-only) — pure TypeScript document model types + immutable
 * mutators. Has no runtime wiring to the engine (no CLI command, no HTTP route, no
 * event subscription). Consumers import the specific functions they need.
 */

export {
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

export type {
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

export type { ValidationError } from "./document.js";

export { nodeBounds, subtreeBounds } from "./geometry.js";
