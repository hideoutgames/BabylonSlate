import { PanelFrame } from "@babylonslate/editor-kit";
import type { IDockviewPanelProps } from "dockview-react";

export function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame title="Inspector" data-testid="inspector-panel">
      <p className="p-4 text-sm text-muted-foreground">
        Selection properties will appear here in P6.
      </p>
    </PanelFrame>
  );
}
