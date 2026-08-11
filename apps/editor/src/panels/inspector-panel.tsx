import type { IDockviewPanelProps } from "dockview-react";

export function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <div
      className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground"
      data-testid="inspector-panel"
    >
      Inspector
    </div>
  );
}
