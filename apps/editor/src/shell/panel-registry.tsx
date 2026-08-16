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
import { SpritePreviewPanel, SpriteDetailsPanel } from "../components/sprite-editor";
import {
  TilesetPreviewPanel,
  TilesetDetailsPanel,
} from "../components/tileset-editor";
import {
  TilemapPaintPanel,
  TilemapDetailsPanel,
} from "../components/tilemap-editor";
import {
  UiDesignPanel,
  UiDetailsPanel,
  UiHierarchyPanel,
  UiSettingsPanel,
} from "../panels/ui-editor-panels";
import {
  MaterialCompilerResultsPanel,
  MaterialDetailsPanel,
  MaterialFunctionGraphPanel,
  MaterialFunctionInterfacePanel,
  MaterialGraphPanel,
  MaterialPreviewPanel,
} from "../components/material-editor";
import { EditorUtilityPanel } from "../panels/editor-utility-panel";
import { PluginSettingsDetailsPanel } from "../panels/plugin-settings-details-panel";
import { LocksPanel } from "../panels/locks-panel";
import {
  AnimGraphDetailsPanel,
  AnimGraphGraphPanel,
  AnimGraphParametersPanel,
} from "../components/anim-graph-editor";
import {
  BehaviourTreeDetailsPanel,
  BehaviourTreeGraphPanel,
} from "../components/behaviour-tree-editor";

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
  "sprite-preview": (props: IDockviewPanelProps) => (
    <SpritePreviewPanel {...props} />
  ),
  "sprite-details": (props: IDockviewPanelProps) => (
    <SpriteDetailsPanel {...props} />
  ),
  "tileset-preview": (props: IDockviewPanelProps) => (
    <TilesetPreviewPanel {...props} />
  ),
  "tileset-details": (props: IDockviewPanelProps) => (
    <TilesetDetailsPanel {...props} />
  ),
  "tilemap-paint": (props: IDockviewPanelProps) => (
    <TilemapPaintPanel {...props} />
  ),
  "tilemap-details": (props: IDockviewPanelProps) => (
    <TilemapDetailsPanel {...props} />
  ),
  "ui-design": (props: IDockviewPanelProps) => <UiDesignPanel {...props} />,
  "ui-hierarchy": (props: IDockviewPanelProps) => (
    <UiHierarchyPanel {...props} />
  ),
  "ui-details": (props: IDockviewPanelProps) => <UiDetailsPanel {...props} />,
  "ui-settings": (props: IDockviewPanelProps) => <UiSettingsPanel {...props} />,
  "material-graph": (props: IDockviewPanelProps) => (
    <MaterialGraphPanel {...props} />
  ),
  "material-preview": (props: IDockviewPanelProps) => (
    <MaterialPreviewPanel {...props} />
  ),
  "material-details": (props: IDockviewPanelProps) => (
    <MaterialDetailsPanel {...props} />
  ),
  "material-compiler-results": (props: IDockviewPanelProps) => (
    <MaterialCompilerResultsPanel {...props} />
  ),
  "material-function-graph": (props: IDockviewPanelProps) => (
    <MaterialFunctionGraphPanel {...props} />
  ),
  "material-function-interface": (props: IDockviewPanelProps) => (
    <MaterialFunctionInterfacePanel {...props} />
  ),
  "editor-utility": (props: IDockviewPanelProps) => (
    <EditorUtilityPanel {...props} />
  ),
  "plugin-settings-details": (props: IDockviewPanelProps) => (
    <PluginSettingsDetailsPanel {...props} />
  ),
  "anim-graph-graph": (props: IDockviewPanelProps) => (
    <AnimGraphGraphPanel {...props} />
  ),
  "anim-graph-parameters": (props: IDockviewPanelProps) => (
    <AnimGraphParametersPanel {...props} />
  ),
  "anim-graph-details": (props: IDockviewPanelProps) => (
    <AnimGraphDetailsPanel {...props} />
  ),
  "behaviour-tree-graph": (props: IDockviewPanelProps) => (
    <BehaviourTreeGraphPanel {...props} />
  ),
  "behaviour-tree-details": (props: IDockviewPanelProps) => (
    <BehaviourTreeDetailsPanel {...props} />
  ),
  locks: (props: IDockviewPanelProps) => <LocksPanel {...props} />,
};
