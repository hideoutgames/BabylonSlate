import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { HandIcon, ArrowUpIcon, ArrowDownIcon, WavesIcon, AlignVerticalJustifyEndIcon, PaintbrushIcon, EraserIcon } from "lucide-react";
import { useSceneTools } from "../context/scene-tools-context";
import type { SceneMode } from "../shell/scene-document-layout";
import type { LandscapeBrushTool } from "@babylonslate/core";

const landscapeTools = [
  ["navigate", "Navigate", HandIcon], ["raise", "Raise", ArrowUpIcon],
  ["lower", "Lower", ArrowDownIcon], ["smooth", "Smooth", WavesIcon],
  ["flatten", "Flatten", AlignVerticalJustifyEndIcon], ["paint", "Paint Layer", PaintbrushIcon],
] as const;
const foliageTools = [["navigate", "Navigate", HandIcon], ["paint", "Paint Foliage", PaintbrushIcon], ["erase", "Erase Foliage", EraserIcon]] as const;

export function SceneBrushToolbar({ mode, disabled }: { mode: SceneMode; disabled?: boolean }) {
  const tools = useSceneTools();
  const landscape = mode === "landscape";
  return <ToggleGroup variant="outline" size="sm" disabled={disabled} value={[landscape ? tools.landscapeTool : tools.foliageTool]}
    aria-label={landscape ? "Landscape Tools" : "Foliage Tools"} className="flex flex-wrap" onValueChange={(values) => {
      const value = values[0];
      if (!value) return;
      if (landscape) tools.setLandscapeTool(value as LandscapeBrushTool | "navigate");
      else if (value === "navigate" || value === "paint" || value === "erase") tools.setFoliageTool(value);
    }}>
    {(landscape ? landscapeTools : foliageTools).map(([value, label, Icon]) => <ToggleGroupItem key={value} value={value} aria-label={label} title={label} className="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"><Icon data-icon="inline-start" /><span className="sr-only">{label}</span></ToggleGroupItem>)}
  </ToggleGroup>;
}
