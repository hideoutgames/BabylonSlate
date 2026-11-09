import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { SquareFunctionIcon } from "lucide-react";
import { isFunctionGraphPanelId } from "./function-graph-panels";

/**
 * Every DockView tab: Dockview's own tab (title, close, middle-click close,
 * pin), led by the Function icon on Class function graphs, as in My Class,
 * so they stand apart from the Event Graph and windows. Keyed on the panel
 * id, so tabs a saved layout restores get the icon too.
 */
export function HapticDockTab(props: IDockviewPanelHeaderProps) {
  return (
    <>
      {isFunctionGraphPanelId(props.api.id) ? (
        <SquareFunctionIcon className="dock-tab-icon" aria-hidden="true" data-tab-icon="function" />
      ) : null}
      <DockviewDefaultTab {...props} />
    </>
  );
}
