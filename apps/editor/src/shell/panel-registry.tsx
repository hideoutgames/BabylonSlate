import type { IDockviewPanelProps } from "dockview";
import { ViewportPanel } from "../panels/viewport-panel";
import { GraphPanel } from "../panels/graph-panel";
import { PlaceholderPanel } from "../panels/placeholder-panel";

export const panelComponents = {
  viewport: (props: IDockviewPanelProps) => <ViewportPanel {...props} />,
  graph: (props: IDockviewPanelProps) => <GraphPanel {...props} />,
  inspector: (props: IDockviewPanelProps) => (
    <PlaceholderPanel {...props} title="Inspector" />
  ),
};
