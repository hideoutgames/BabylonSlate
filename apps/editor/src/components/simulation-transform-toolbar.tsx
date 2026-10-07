import type { GizmoTool } from "@babylonslate/render";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { MoveIcon, RotateCwIcon, ScalingIcon } from "lucide-react";

/** Same transform tools as the authoring viewport, routed to validated live setters. */
export function SimulationTransformToolbar({ tool, onToolChange }: { tool: GizmoTool; onToolChange: (tool: GizmoTool) => void }) {
  return <ToggleGroup variant="outline" size="sm" spacing={0} value={[tool]}
    className="pointer-events-auto bg-popover" aria-label="Runtime Transform Tool"
    onValueChange={values => { const next = values[0]; if (next === "translate" || next === "rotate" || next === "scale") onToolChange(next); }}>
    <ToggleGroupItem value="translate" aria-label="Move"><MoveIcon />Move</ToggleGroupItem>
    <ToggleGroupItem value="rotate" aria-label="Rotate"><RotateCwIcon />Rotate</ToggleGroupItem>
    <ToggleGroupItem value="scale" aria-label="Scale"><ScalingIcon />Scale</ToggleGroupItem>
  </ToggleGroup>;
}
