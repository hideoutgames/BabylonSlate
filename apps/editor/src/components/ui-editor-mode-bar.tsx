import { ToolbarStrip } from "@babylonslate/editor-kit";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import type { UiEditorMode } from "../shell/ui-document-layout";

export function UiEditorModeBar({
  mode,
  onModeChange,
}: {
  mode: UiEditorMode;
  onModeChange: (mode: UiEditorMode) => void;
}) {
  return (
    <ToolbarStrip data-testid="ui-editor-mode-bar">
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[mode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "designer" || next === "logic") onModeChange(next);
        }}
        aria-label="Editor Mode"
        data-testid="ui-editor-mode"
      >
        <ToggleGroupItem value="designer" data-testid="ui-editor-mode-designer">
          Designer
        </ToggleGroupItem>
        <ToggleGroupItem value="logic" data-testid="ui-editor-mode-logic">
          Logic
        </ToggleGroupItem>
      </ToggleGroup>
    </ToolbarStrip>
  );
}
