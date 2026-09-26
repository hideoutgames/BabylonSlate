import { AlignVerticalJustifyEndIcon, ArrowDownIcon, ArrowUpIcon, EraserIcon, HandIcon, PaintbrushIcon, WavesIcon, type LucideIcon } from "lucide-react";
import type { LandscapeBrushTool } from "@babylonslate/core";

export type LandscapeTool = LandscapeBrushTool | "navigate";
export type FoliageTool = "navigate" | "paint" | "erase";

type ToolDefinition<T extends string> = { value: T; label: string; icon: LucideIcon };

/** Island groups; separators sit between groups. */
export const LANDSCAPE_TOOL_GROUPS: ToolDefinition<LandscapeTool>[][] = [
  [{ value: "navigate", label: "Navigate", icon: HandIcon }],
  [
    { value: "raise", label: "Raise", icon: ArrowUpIcon },
    { value: "lower", label: "Lower", icon: ArrowDownIcon },
    { value: "smooth", label: "Smooth", icon: WavesIcon },
    { value: "flatten", label: "Flatten", icon: AlignVerticalJustifyEndIcon },
  ],
  [{ value: "paint", label: "Paint Layer", icon: PaintbrushIcon }],
];

export const FOLIAGE_TOOL_GROUPS: ToolDefinition<FoliageTool>[][] = [
  [{ value: "navigate", label: "Navigate", icon: HandIcon }],
  [
    { value: "paint", label: "Paint Foliage", icon: PaintbrushIcon },
    { value: "erase", label: "Erase Foliage", icon: EraserIcon },
  ],
];

export const LANDSCAPE_TOOL_LABELS = Object.fromEntries(LANDSCAPE_TOOL_GROUPS.flat().map((tool) => [tool.value, tool.label])) as Record<LandscapeTool, string>;
export const FOLIAGE_TOOL_LABELS = Object.fromEntries(FOLIAGE_TOOL_GROUPS.flat().map((tool) => [tool.value, tool.label])) as Record<FoliageTool, string>;
