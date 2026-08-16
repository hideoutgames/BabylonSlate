import { ToolbarStrip } from "@babylonslate/editor-kit";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import type { AnimEditorMode } from "../shell/anim-document-layout";

export function AnimEditorModeBar({
  mode,
  onModeChange,
}: {
  mode: AnimEditorMode;
  onModeChange: (mode: AnimEditorMode) => void;
}) {
  return (
    <ToolbarStrip data-testid="anim-editor-mode-bar">
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[mode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "stateMachine" || next === "animationObject") {
            onModeChange(next);
          }
        }}
        aria-label="Animation Graph Mode"
        data-testid="anim-editor-mode"
      >
        <ToggleGroupItem
          value="stateMachine"
          data-testid="anim-editor-mode-state-machine"
        >
          State Machine
        </ToggleGroupItem>
        <ToggleGroupItem
          value="animationObject"
          data-testid="anim-editor-mode-animation-object"
        >
          Animation Object
        </ToggleGroupItem>
      </ToggleGroup>
    </ToolbarStrip>
  );
}
