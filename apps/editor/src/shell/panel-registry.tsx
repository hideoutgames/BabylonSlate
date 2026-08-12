import type { IDockviewPanelProps } from "dockview-react";
import { ViewportPanel } from "../panels/viewport-panel";
import { GraphPanel } from "../panels/graph-panel";
import { InspectorPanel } from "../panels/inspector-panel";
import { OutputLogPanel } from "../panels/output-log-panel";
import { CompilerResultsPanel } from "../panels/compiler-results-panel";
import { MyClassPanel } from "../panels/my-class-panel";
import { SceneOutlinerPanel } from "../panels/scene-outliner-panel";
import { SceneDetailsPanel } from "../panels/scene-details-panel";
import { MiniAssetBrowserPanel } from "../panels/mini-asset-browser-panel";
import { ActorPrefabPanel } from "../panels/actor-prefab-panel";

export const panelComponents = {
  viewport: (props: IDockviewPanelProps) => <ViewportPanel {...props} />,
  graph: (props: IDockviewPanelProps) => <GraphPanel {...props} />,
  inspector: (props: IDockviewPanelProps) => <InspectorPanel {...props} />,
  "output-log": (props: IDockviewPanelProps) => <OutputLogPanel {...props} />,
  "compiler-results": (props: IDockviewPanelProps) => (
    <CompilerResultsPanel {...props} />
  ),
  "my-class": (props: IDockviewPanelProps) => <MyClassPanel {...props} />,
  "scene-outliner": (props: IDockviewPanelProps) => (
    <SceneOutlinerPanel {...props} />
  ),
  "scene-details": (props: IDockviewPanelProps) => (
    <SceneDetailsPanel {...props} />
  ),
  "mini-asset-browser": (props: IDockviewPanelProps) => (
    <MiniAssetBrowserPanel {...props} />
  ),
  "actor-prefab": (props: IDockviewPanelProps) => <ActorPrefabPanel {...props} />,
};
