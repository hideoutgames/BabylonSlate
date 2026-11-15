import { useMemo } from "react";
import { treeEdgeOptions, treeNodeTypes } from "@haptic/graph-ui";
import { behaviourTreeDiffGraph } from "../lib/behaviour-tree-diff-graph";
import { DiffGraphCanvas } from "../panels/diff-graph-canvas";
import type { DiffCanvasFamily, DiffCanvasProps } from "../panels/diff-graph-canvas-model";

/**
 * The Diff window's canvas for a Behaviour Tree, which loads with the tree
 * editor: its node cards (decorators and services included) and org-chart
 * wires.
 */
export function BehaviourTreeDiffCanvas(props: DiffCanvasProps) {
  const family = useMemo<DiffCanvasFamily>(() => ({
    toGraph: behaviourTreeDiffGraph,
    nodeTypes: treeNodeTypes,
    editorProps: { defaultEdgeOptions: treeEdgeOptions },
    className: "bt-graph-canvas",
  }), []);
  return <DiffGraphCanvas {...props} family={family} />;
}
