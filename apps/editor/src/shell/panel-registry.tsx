import type { IDockviewPanelProps } from "dockview-react";
import { ViewportPanel } from "../panels/viewport-panel";
import { GraphPanel } from "../panels/graph-panel";
import { InspectorPanel } from "../panels/inspector-panel";

export const panelComponents = {
  viewport: (props: IDockviewPanelProps) => <ViewportPanel {...props} />,
  graph: (props: IDockviewPanelProps) => <GraphPanel {...props} />,
  inspector: (props: IDockviewPanelProps) => <InspectorPanel {...props} />,
};
