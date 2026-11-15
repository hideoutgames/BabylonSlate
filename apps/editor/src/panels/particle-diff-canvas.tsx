import { useMemo } from "react";
import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";
import { particleDiffGraph } from "../lib/particle-diff-graph";
import { DiffGraphCanvas } from "./diff-graph-canvas";
import type { DiffCanvasFamily, DiffCanvasProps } from "./diff-graph-canvas-model";

/**
 * The Diff window's canvas for a Particle Graph, which loads with the
 * Particle editors: its pin nodes, hydrated as the Particle Graph window
 * hydrates them.
 */
export function ParticleDiffCanvas(props: DiffCanvasProps) {
  const globalParameters = useGlobalParameterCatalog();
  const family = useMemo<DiffCanvasFamily>(() => ({ toGraph: (stored) => particleDiffGraph(stored, globalParameters) }), [globalParameters]);
  return <DiffGraphCanvas {...props} family={family} />;
}
