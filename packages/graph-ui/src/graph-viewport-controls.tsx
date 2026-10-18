import { useReactFlow, useStore } from "@xyflow/react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Separator } from "@babylonslate/ui/components/separator";
import { IslandIconButton } from "./island-icon-button";

/** Canvas sibling so transformed or elevated nodes cannot cover navigation. */
export function GraphViewportControls({ onFitGraph }: { onFitGraph: () => void }) {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const atMinZoom = useStore((state) => state.transform[2] <= state.minZoom);
  const atMaxZoom = useStore((state) => state.transform[2] >= state.maxZoom);

  return (
    <div
      role="group"
      aria-label="Graph Navigation"
      data-testid="graph-viewport-controls"
      data-graph-overlay=""
      className="toolbar-island toolbar-island-vertical absolute bottom-2 left-2 z-10"
    >
      <IslandIconButton label="Zoom In" side="right" disabled={atMaxZoom} onClick={() => { void zoomIn(); }}>
        <PlusIcon />
      </IslandIconButton>
      <IslandIconButton
        label="Reset Zoom"
        hint="Reset Zoom To 100%"
        side="right"
        className="h-5 w-7 text-[10px] tabular-nums"
        onClick={() => { void zoomTo(1); }}
        data-testid="graph-zoom-level"
      >
        {Math.round(zoom * 100)}%
      </IslandIconButton>
      <IslandIconButton label="Zoom Out" side="right" disabled={atMinZoom} onClick={() => { void zoomOut(); }}>
        <MinusIcon />
      </IslandIconButton>
      <Separator orientation="horizontal" />
      <IslandIconButton label="Size Graph To Fit" side="right" onClick={() => { void onFitGraph(); }}>
        <MaximizeIcon />
      </IslandIconButton>
    </div>
  );
}
