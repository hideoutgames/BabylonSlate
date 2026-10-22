import type { GizmoTool } from "@haptic/render";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { MoveIcon, RotateCwIcon, ScalingIcon } from "lucide-react";

const TOOLS = [
  { id: "translate", label: "Move", icon: MoveIcon },
  { id: "rotate", label: "Rotate", icon: RotateCwIcon },
  { id: "scale", label: "Scale", icon: ScalingIcon },
] as const;

/** Same transform tools as the authoring viewport island, routed to validated live setters. */
export function SimulationTransformToolbar({ tool, onToolChange }: { tool: GizmoTool; onToolChange: (tool: GizmoTool) => void }) {
  return <div className="pointer-events-auto toolbar-island toolbar-island-touch self-start">
    <ToggleGroup variant="outline" size="sm" spacing={0} value={[tool]} aria-label="Runtime Transform Tool"
      onValueChange={values => { const next = values[0]; if (next === "translate" || next === "rotate" || next === "scale") onToolChange(next); }}>
      {TOOLS.map(({ id, label, icon: Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger render={<ToggleGroupItem value={id} aria-label={label} data-testid={`simulation-transform-${id}`}><Icon /></ToggleGroupItem>} />
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  </div>;
}
