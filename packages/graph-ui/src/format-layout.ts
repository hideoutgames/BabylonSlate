/**
 * A host's own Format: the graph as the canvas holds it in, the nodes' new positions out. `GraphEditor.formatLayout`
 * runs one in place of the Script graph formatter (`formatGraphNodes`).
 */

/** A node as a Format layout sees it: its position, its measured size (else the editor's estimate) and its data. */
export type FormatLayoutNode = {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  /** The node's data object, so a host's layout can read its own fields. */
  data: Record<string, unknown>;
};

export type FormatLayoutEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
};

/**
 * Lays out a graph for Format. `selectedIds` is empty when nothing is selected; the layout decides what that means.
 * Returns new top-left positions; unknown ids are ignored and a node left out keeps its place.
 */
export type GraphFormatLayout = (input: {
  nodes: FormatLayoutNode[];
  edges: FormatLayoutEdge[];
  selectedIds: string[];
}) => Array<{ id: string; position: { x: number; y: number } }>;

export type FormatLayoutBox = { x: number; y: number; width: number; height: number };

export function formatLayoutBoxesOverlap(a: FormatLayoutBox, b: FormatLayoutBox, clearance = 0): boolean {
  return (
    a.x < b.x + b.width + clearance &&
    b.x < a.x + a.width + clearance &&
    a.y < b.y + b.height + clearance &&
    b.y < a.y + a.height + clearance
  );
}
