import { useMemo } from "react";
import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";
import { materialDiffGraph } from "../lib/material-diff-graph";
import { DiffGraphCanvas } from "../panels/diff-graph-canvas";
import type { DiffCanvasFamily, DiffCanvasProps } from "../panels/diff-graph-canvas-model";
import { renderMaterialNodeBody } from "./material-custom-glsl";

/**
 * The Diff window's canvas for a Material or Material Function graph, which
 * loads with the Material editor: its pin nodes and Custom GLSL bodies,
 * hydrated as the Material Graph window hydrates them.
 */
export function MaterialDiffCanvas(props: DiffCanvasProps) {
  const globalParameters = useGlobalParameterCatalog();
  const { assetType } = props;
  const family = useMemo<DiffCanvasFamily>(() => ({
    toGraph: (stored) => materialDiffGraph(stored, assetType, globalParameters),
    renderNodeBody: renderMaterialNodeBody,
  }), [assetType, globalParameters]);
  return <DiffGraphCanvas {...props} family={family} />;
}
