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
import {
  SpritePreviewPanel,
  SpriteDetailsPanel,
} from "../components/sprite-editor";
import {
  AudioClipsPanel,
  AudioDetailsPanel,
  AudioPreviewPanel,
} from "../components/audio-editor";
import {
  SpriteAnimationPreviewPanel,
  SpriteAnimationDetailsPanel,
} from "../components/sprite-animation-editor";
import {
  TilesetPreviewPanel,
  TilesetDetailsPanel,
} from "../components/tileset-editor";
import {
  TilemapPaintPanel,
  TilemapDetailsPanel,
  TilemapPalettePanel,
} from "../components/tilemap-editor";
import {
  UiDesignPanel,
  UiDetailsPanel,
  UiHierarchyPanel,
} from "../panels/ui-editor-panels";
import {
  MaterialCompilerResultsPanel,
  MaterialDetailsPanel,
  MaterialFunctionGraphPanel,
  MaterialFunctionInterfacePanel,
  MaterialGraphPanel,
  MaterialPreviewPanel,
} from "../components/material-editor";
import { PluginSettingsDetailsPanel } from "../panels/plugin-settings-details-panel";
import {
  AudioChannelDetailsPanel,
  AudioMixerDetailsPanel,
  SoundAttenuationDetailsPanel,
} from "../components/audio-asset-editor";
import {
  ParticleEmitterDetailsPanel,
  ParticleEmitterPreviewPanel,
  ParticleSystemDetailsPanel,
  ParticleSystemPreviewPanel,
} from "../components/particle-editor";
import {
  SkyboxCreatorDetailsPanel,
  SkyboxCreatorPreviewPanel,
} from "../components/skybox-creator-editor";
import { LocksPanel } from "../panels/locks-panel";
import {
  AnimGraphDetailsPanel,
  AnimGraphGraphPanel,
  AnimGraphParametersPanel,
  AnimGraphVariablesPanel,
  AnimObjectVariablesPanel,
} from "../components/anim-graph-editor";
import {
  BehaviourTreeBlackboardPanel,
  BehaviourTreeCompilerResultsPanel,
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
  "audio-preview": (props: IDockviewPanelProps) => (
    <AudioPreviewPanel {...props} />
  ),
  "audio-details": (props: IDockviewPanelProps) => (
    <AudioDetailsPanel {...props} />
  ),
  "audio-clips": (props: IDockviewPanelProps) => (
    <AudioClipsPanel {...props} />
  ),
  "sprite-animation-preview": (props: IDockviewPanelProps) => (
    <SpriteAnimationPreviewPanel {...props} />
  ),
  "sprite-animation-details": (props: IDockviewPanelProps) => (
    <SpriteAnimationDetailsPanel {...props} />
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
  "tilemap-palette": (props: IDockviewPanelProps) => (
    <TilemapPalettePanel {...props} />
  ),
  "tilemap-details": (props: IDockviewPanelProps) => (
    <TilemapDetailsPanel {...props} />
  ),
  "ui-design": (props: IDockviewPanelProps) => <UiDesignPanel {...props} />,
  "ui-hierarchy": (props: IDockviewPanelProps) => (
    <UiHierarchyPanel {...props} />
  ),
  "ui-details": (props: IDockviewPanelProps) => <UiDetailsPanel {...props} />,
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
  "plugin-settings-details": (props: IDockviewPanelProps) => (
    <PluginSettingsDetailsPanel {...props} />
  ),
  "audio-mixer-details": (props: IDockviewPanelProps) => (
    <AudioMixerDetailsPanel {...props} />
  ),
  "audio-channel-details": (props: IDockviewPanelProps) => (
    <AudioChannelDetailsPanel {...props} />
  ),
  "sound-attenuation-details": (props: IDockviewPanelProps) => (
    <SoundAttenuationDetailsPanel {...props} />
  ),
  "particle-emitter-preview": (props: IDockviewPanelProps) => (
    <ParticleEmitterPreviewPanel {...props} />
  ),
  "particle-emitter-details": (props: IDockviewPanelProps) => (
    <ParticleEmitterDetailsPanel {...props} />
  ),
  "particle-system-preview": (props: IDockviewPanelProps) => (
    <ParticleSystemPreviewPanel {...props} />
  ),
  "particle-system-details": (props: IDockviewPanelProps) => (
    <ParticleSystemDetailsPanel {...props} />
  ),
  "skybox-creator-preview": (props: IDockviewPanelProps) => (
    <SkyboxCreatorPreviewPanel {...props} />
  ),
  "skybox-creator-details": (props: IDockviewPanelProps) => (
    <SkyboxCreatorDetailsPanel {...props} />
  ),
  "anim-graph-graph": (props: IDockviewPanelProps) => (
    <AnimGraphGraphPanel {...props} />
  ),
  "anim-graph-parameters": (props: IDockviewPanelProps) => (
    <AnimGraphParametersPanel {...props} />
  ),
  "anim-graph-variables": (props: IDockviewPanelProps) => (
    <AnimGraphVariablesPanel {...props} />
  ),
  "anim-graph-details": (props: IDockviewPanelProps) => (
    <AnimGraphDetailsPanel {...props} />
  ),
  "anim-graph-compiler-results": (props: IDockviewPanelProps) => (
    <CompilerResultsPanel {...props} />
  ),
  "anim-object-graph": (props: IDockviewPanelProps) => (
    <GraphPanel {...props} />
  ),
  "anim-object-variables": (props: IDockviewPanelProps) => (
    <AnimObjectVariablesPanel {...props} />
  ),
  "anim-object-inspector": (props: IDockviewPanelProps) => (
    <InspectorPanel {...props} />
  ),
  "behaviour-tree-graph": (props: IDockviewPanelProps) => (
    <BehaviourTreeGraphPanel {...props} />
  ),
  "behaviour-tree-details": (props: IDockviewPanelProps) => (
    <BehaviourTreeDetailsPanel {...props} />
  ),
  "behaviour-tree-blackboard": (props: IDockviewPanelProps) => (
    <BehaviourTreeBlackboardPanel {...props} />
  ),
  "behaviour-tree-compiler-results": (props: IDockviewPanelProps) => (
    <BehaviourTreeCompilerResultsPanel {...props} />
  ),
  locks: (props: IDockviewPanelProps) => <LocksPanel {...props} />,
};
