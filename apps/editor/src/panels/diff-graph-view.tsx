import { useState, type ComponentType, type ReactNode } from "react";
import type { GraphDiff } from "@haptic/assets/asset-diff";
import { Button } from "@haptic/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { lazyPanel } from "../shell/lazy-dock-panel";
import { ScriptDiffCanvas } from "./diff-graph-canvas";
import { graphDiffSection, hasDiffCanvas, type DiffCanvasKind, type DiffCanvasProps, type DiffMode } from "./diff-graph-canvas-model";

type Canvas = ComponentType<DiffCanvasProps>;

const renderingFamily = () => import("../shell/asset-panels/rendering");
const animationAiFamily = () => import("../shell/asset-panels/animation-ai");

let canvases: Record<DiffCanvasKind, Canvas> | null = null;

/**
 * Each family's canvas loads with its editor's chunk (its node components
 * and hydration) the first time a diff shows one of its graphs; script
 * graphs need only the graph editor this view brings. Built on first use,
 * never at module load.
 */
function canvasFor(kind: DiffCanvasKind): Canvas {
  canvases ??= {
    script: ScriptDiffCanvas,
    material: lazyPanel(renderingFamily, (family) => family.MaterialDiffCanvas),
    particle: lazyPanel(renderingFamily, (family) => family.ParticleDiffCanvas),
    "behaviour-tree": lazyPanel(animationAiFamily, (family) => family.BehaviourTreeDiffCanvas),
    "state-machine": lazyPanel(animationAiFamily, (family) => family.AnimStateMachineDiffCanvas),
  };
  return canvases[kind];
}

/**
 * A graph diff on its family's read-only canvas: **Overlay**, **Base** or
 * the compare version; changed nodes outlined warning, added success,
 * removed destructive and dashed, each tagged. Several changed graphs (a
 * Class's functions, an Animation Graph's states) are chosen above it. The
 * canvas mounts only while the window is on screen. The Diff window shows
 * this view only for a graph with a canvas (`hasDiffCanvas`).
 */
export default function GraphDiffView({ graph, selection, onSelect, assetType, baseLabel, compareLabel, shown, toolbar }: {
  graph: GraphDiff;
  /** As `graphDiffSection` reads it. */
  selection: string | null;
  onSelect: (id: string) => void;
  assetType: string;
  baseLabel: string;
  compareLabel: string;
  shown: boolean;
  toolbar: (controls: ReactNode) => ReactNode;
}) {
  const [mode, setMode] = useState<DiffMode>("overlay");
  const changed = graph.sections.filter((section) => section.status !== "unchanged");
  const { section, nodeId } = graphDiffSection(graph, selection);
  const kind = section && hasDiffCanvas(section.canvas) ? section.canvas : null;
  const Canvas = kind ? canvasFor(kind) : null;
  const controls = (
    <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="Show" value={[mode]} onValueChange={(value) => { if (value[0]) setMode(value[0] as DiffMode); }}>
      <ToggleGroupItem value="overlay" data-testid="diff-graph-overlay">Overlay</ToggleGroupItem>
      <ToggleGroupItem value="base" data-testid="diff-graph-base" title={baseLabel}>Base</ToggleGroupItem>
      <ToggleGroupItem value="compare" data-testid="diff-graph-compare">{compareLabel}</ToggleGroupItem>
    </ToggleGroup>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar(controls)}
      {changed.length > 1 ? (
        <div className="flex shrink-0 flex-wrap gap-1 px-1.5 pt-1.5" role="group" aria-label="Graphs">
          {changed.map((entry) => (
            <Button key={entry.id} variant={entry === section ? "secondary" : "ghost"} size="sm" aria-pressed={entry === section} onClick={() => onSelect(entry.id)} data-testid={`diff-graph-section-${entry.id}`}>
              {entry.title}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1" data-testid="diff-graph" data-canvas={kind ?? undefined}>
        {section && Canvas && shown ? <Canvas key={kind} section={section} mode={mode} assetType={assetType} {...(nodeId ? { focusedNodeId: nodeId } : {})} /> : null}
      </div>
    </div>
  );
}
