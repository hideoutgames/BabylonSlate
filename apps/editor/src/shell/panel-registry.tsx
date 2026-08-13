import type { IDockviewPanelProps } from "dockview-react";
import { ViewportPanel } from "../panels/viewport-panel";
import { GraphPanel } from "../panels/graph-panel";
import { InspectorPanel } from "../panels/inspector-panel";
import { OutputLogPanel } from "../panels/output-log-panel";
import { CompilerResultsPanel } from "../panels/compiler-results-panel";
import { MyClassPanel } from "../panels/my-class-panel";
import { SceneOutlinerPanel } from "../panels/scene-outliner-panel";
import { SceneDetailsPanel } from "../panels/scene-details-panel";
import { ActorPrefabPanel } from "../panels/actor-prefab-panel";
import { PrefabViewportPanel } from "../panels/prefab-viewport-panel";

import { TypeMembersPanel } from "../panels/type-members-panel";
import { TypeDetailsPanel } from "../panels/type-details-panel";
import { InterfaceMethodsPanel } from "../panels/interface-methods-panel";
import { InterfacePreviewPanel } from "../panels/interface-preview-panel";
import { InterfaceDetailsPanel } from "../panels/interface-details-panel";

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
  "mini-asset-browser": () => null,
  "actor-prefab": (props: IDockviewPanelProps) => <ActorPrefabPanel {...props} />,
  "prefab-viewport": (props: IDockviewPanelProps) => (
    <PrefabViewportPanel {...props} />
  ),
  "type-members": (props: IDockviewPanelProps) => (
    <TypeMembersPanel {...props} />
  ),
  "type-details": (props: IDockviewPanelProps) => (
    <TypeDetailsPanel {...props} />
  ),
  "script-interface-methods": (props: IDockviewPanelProps) => (
    <InterfaceMethodsPanel {...props} />
  ),
  "script-interface-preview": (props: IDockviewPanelProps) => (
    <InterfacePreviewPanel {...props} />
  ),
  "script-interface-details": (props: IDockviewPanelProps) => (
    <InterfaceDetailsPanel {...props} />
  ),
};
