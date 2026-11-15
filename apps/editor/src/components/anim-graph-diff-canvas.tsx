import { useMemo } from "react";
import { animGraphEdgeTypes, animGraphNodeTypes } from "@haptic/graph-ui";
import { animStateMachineDiffGraph } from "../lib/anim-graph-diff-graph";
import { DiffGraphCanvas } from "../panels/diff-graph-canvas";
import type { DiffCanvasFamily, DiffCanvasProps } from "../panels/diff-graph-canvas-model";

/**
 * The Diff window's canvas for an Animation Graph's State Machine, which
 * loads with the Animation Graph editor: its state and State Alias cards and
 * transition wires. Its state, rule and Animation Object graphs are script
 * graphs, drawn on the script canvas.
 */
export function AnimStateMachineDiffCanvas(props: DiffCanvasProps) {
  const { assetType } = props;
  const family = useMemo<DiffCanvasFamily>(() => ({
    toGraph: (stored) => animStateMachineDiffGraph(stored, assetType),
    nodeTypes: animGraphNodeTypes,
    editorProps: { edgeTypes: animGraphEdgeTypes, defaultEdgeOptions: { type: "animTransition" }, connectionMode: "loose" },
    className: "anim-graph-canvas",
  }), [assetType]);
  return <DiffGraphCanvas {...props} family={family} />;
}
