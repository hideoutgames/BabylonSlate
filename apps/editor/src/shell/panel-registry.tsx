import type { IDockviewPanelProps } from "dockview-react";
import { lazyPanel, type DockPanel } from "./lazy-dock-panel";
import { ViewportPanel } from "../panels/viewport-panel";
import { GraphPanel } from "../panels/graph-panel";
import { InspectorPanel } from "../panels/inspector-panel";
import { OutputLogPanel } from "../panels/output-log-panel";
import { CompilerResultsPanel } from "../panels/compiler-results-panel";
import { MyClassPanel } from "../panels/my-class-panel";
import { SceneOutlinerPanel } from "../panels/scene-outliner-panel";
import { SceneDetailsPanel } from "../panels/scene-details-panel";
import { SceneAssetsPanel } from "../panels/scene-assets-panel";
import { LocksPanel } from "../panels/locks-panel";
import { BreakpointsPanel } from "../panels/breakpoints-panel";
import {
  FoliageGroupsPanel,
  FoliageOutlinerPanel,
  FoliageSettingsPanel,
  LandscapeOutlinerPanel,
  LandscapeSettingsPanel,
} from "../panels/scene-environment-panels";
import { TimelineClipsPanel, TimelinePanel } from "../panels/timeline-panels";

/**
 * Scene and Scene Layer windows in every mode, imported with the Editor route: a project opens on a Scene, so these
 * panels never wait for a download.
 */
export const scenePanelComponents = {
  viewport: (props: IDockviewPanelProps) => <ViewportPanel {...props} />,
  graph: (props: IDockviewPanelProps) => <GraphPanel {...props} />,
  // FUNCTION_GRAPH_PANEL_COMPONENT; a literal key, since an imported constant
  // can still be undefined here when bundle chunks evaluate in a cycle.
  "function-graph": (props: IDockviewPanelProps) => <GraphPanel {...props} />,
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
  "scene-assets": (props: IDockviewPanelProps) => <SceneAssetsPanel {...props} />,
  locks: (props: IDockviewPanelProps) => <LocksPanel {...props} />,
  breakpoints: () => <BreakpointsPanel />,
  "landscape-outliner": LandscapeOutlinerPanel,
  "landscape-settings": LandscapeSettingsPanel,
  "foliage-groups": FoliageGroupsPanel,
  "foliage-settings": FoliageSettingsPanel,
  "foliage-outliner": FoliageOutlinerPanel,
  "timeline-clips": TimelineClipsPanel,
  "scene-timeline": TimelinePanel,
} satisfies Record<string, DockPanel>;

// Each family is one download: a document's first panel of a family loads every editor in it.
const classPanels = () => import("./asset-panels/class");
const animationAiPanels = () => import("./asset-panels/animation-ai");
const renderingPanels = () => import("./asset-panels/rendering");
const panels2d = () => import("./asset-panels/2d");
const panels3d = () => import("./asset-panels/3d");
const dataPanels = () => import("./asset-panels/data");

/**
 * Every other document kind's windows, loaded by family. Each lazily loaded module is a chunk entry, and the bundler
 * splits the code it shares with the Homepage and the Editor route by which entries reach it, so a few large families
 * keep those routes in fewer, larger chunks than one entry per asset editor would.
 */
const assetEditorPanelComponents = {
  "save-game-fields": lazyPanel(dataPanels, (m) => m.SaveGameFieldsPanel),
  "save-game-definition": lazyPanel(dataPanels, (m) => m.SaveGameDefinitionPanel),
  watches: lazyPanel(classPanels, (m) => m.WatchesPanel),
  "actor-prefab": lazyPanel(classPanels, (m) => m.ActorPrefabPanel),
  "prefab-viewport": lazyPanel(classPanels, (m) => m.PrefabViewportPanel),
  "type-members": lazyPanel(classPanels, (m) => m.TypeMembersPanel),
  "type-details": lazyPanel(classPanels, (m) => m.TypeDetailsPanel),
  "script-interface-methods": lazyPanel(classPanels, (m) => m.InterfaceMethodsPanel),
  "script-interface-preview": lazyPanel(classPanels, (m) => m.InterfacePreviewPanel),
  "script-interface-details": lazyPanel(classPanels, (m) => m.InterfaceDetailsPanel),
  "sprite-preview": lazyPanel(panels2d, (m) => m.SpritePreviewPanel),
  "sprite-details": lazyPanel(panels2d, (m) => m.SpriteDetailsPanel),
  "audio-preview": lazyPanel(dataPanels, (m) => m.AudioPreviewPanel),
  "audio-details": lazyPanel(dataPanels, (m) => m.AudioDetailsPanel),
  "audio-clips": lazyPanel(dataPanels, (m) => m.AudioClipsPanel),
  "sprite-animation-preview": lazyPanel(panels2d, (m) => m.SpriteAnimationPreviewPanel),
  "sprite-animation-details": lazyPanel(panels2d, (m) => m.SpriteAnimationDetailsPanel),
  "tileset-preview": lazyPanel(panels2d, (m) => m.TilesetPreviewPanel),
  "tileset-details": lazyPanel(panels2d, (m) => m.TilesetDetailsPanel),
  "tileset-autotiles": lazyPanel(panels2d, (m) => m.TilesetAutotilesPanel),
  "tilemap-paint": lazyPanel(panels2d, (m) => m.TilemapPaintPanel),
  "tilemap-palette": lazyPanel(panels2d, (m) => m.TilemapPalettePanel),
  "tilemap-details": lazyPanel(panels2d, (m) => m.TilemapDetailsPanel),
  "material-graph": lazyPanel(renderingPanels, (m) => m.MaterialGraphPanel),
  "material-preview": lazyPanel(renderingPanels, (m) => m.MaterialPreviewPanel),
  "camera-shake-preview": lazyPanel(renderingPanels, (m) => m.CameraShakePreviewPanel),
  "camera-shake-details": lazyPanel(renderingPanels, (m) => m.CameraShakeDetailsPanel),
  "material-details": lazyPanel(renderingPanels, (m) => m.MaterialDetailsPanel),
  "material-compiler-results": lazyPanel(renderingPanels, (m) => m.MaterialCompilerResultsPanel),
  "material-function-graph": lazyPanel(renderingPanels, (m) => m.MaterialFunctionGraphPanel),
  "material-function-interface": lazyPanel(renderingPanels, (m) => m.MaterialFunctionInterfacePanel),
  "material-instance-preview": lazyPanel(renderingPanels, (m) => m.MaterialInstancePreviewPanel),
  "material-instance-details": lazyPanel(renderingPanels, (m) => m.MaterialInstanceDetailsPanel),
  "plugin-settings-details": lazyPanel(dataPanels, (m) => m.PluginSettingsDetailsPanel),
  "input-bindings": lazyPanel(dataPanels, (m) => m.InputBindingsPanel),
  "input-details": lazyPanel(dataPanels, (m) => m.InputBindingDetailsPanel),
  "data-definition-fields": lazyPanel(dataPanels, (m) => m.DataDefinitionFieldsPanel),
  "data-definition-details": lazyPanel(dataPanels, (m) => m.DataDefinitionDetailsPanel),
  "data-tree-hierarchy": lazyPanel(dataPanels, (m) => m.DataTreeHierarchyPanel),
  "data-tree-values": lazyPanel(dataPanels, (m) => m.DataTreeValuesPanel),
  "data-tree-validation": lazyPanel(dataPanels, (m) => m.DataTreeValidationPanel),
  "data-tree-entries": lazyPanel(dataPanels, (m) => m.DataTreeEntriesPanel),
  "audio-mixer-details": lazyPanel(dataPanels, (m) => m.AudioMixerDetailsPanel),
  "audio-channel-details": lazyPanel(dataPanels, (m) => m.AudioChannelDetailsPanel),
  "sound-attenuation-details": lazyPanel(dataPanels, (m) => m.SoundAttenuationDetailsPanel),
  "curve-asset-editor": lazyPanel(dataPanels, (m) => m.CurveAssetEditorPanel),
  "curve-asset-details": lazyPanel(dataPanels, (m) => m.CurveAssetDetailsPanel),
  "global-parameter-collection": lazyPanel(dataPanels, (m) => m.GlobalParameterCollectionPanel),
  "timeline-asset-clips": lazyPanel(dataPanels, (m) => m.TimelineAssetClipsPanel),
  "timeline-asset-events": lazyPanel(dataPanels, (m) => m.TimelineAssetEventsPanel),
  "timeline-clip-proxies": lazyPanel(dataPanels, (m) => m.TimelineClipProxiesPanel),
  "timeline-clip-inspector": lazyPanel(dataPanels, (m) => m.TimelineClipInspectorPanel),
  "timeline-clip-timeline": lazyPanel(dataPanels, (m) => m.TimelineClipTimelinePanel),
  "timeline-clip-viewport": lazyPanel(dataPanels, (m) => m.TimelineClipPreviewPanel),
  "particle-emitter-preview": lazyPanel(renderingPanels, (m) => m.ParticleEmitterPreviewPanel),
  "particle-emitter-details": lazyPanel(renderingPanels, (m) => m.ParticleEmitterDetailsPanel),
  "particle-graph-canvas": lazyPanel(renderingPanels, (m) => m.ParticleGraphCanvasPanel),
  "particle-graph-preview": lazyPanel(renderingPanels, (m) => m.ParticleGraphPreviewPanel),
  "particle-graph-details": lazyPanel(renderingPanels, (m) => m.ParticleGraphDetailsPanel),
  "particle-graph-compiler-results": lazyPanel(renderingPanels, (m) => m.ParticleGraphCompilerResultsPanel),
  "water-preview": lazyPanel(renderingPanels, (m) => m.WaterPreviewPanel),
  "water-details": lazyPanel(renderingPanels, (m) => m.WaterDetailsPanel),
  "render-target-details": lazyPanel(renderingPanels, (m) => m.RenderTargetDetailsPanel),
  "render-target-texture-details": lazyPanel(renderingPanels, (m) => m.RenderTargetTextureDetailsPanel),
  "particle-system-preview": lazyPanel(renderingPanels, (m) => m.ParticleSystemPreviewPanel),
  "particle-system-details": lazyPanel(renderingPanels, (m) => m.ParticleSystemDetailsPanel),
  "model-preview": lazyPanel(panels3d, (m) => m.ModelPreviewPanel),
  "model-colliders": lazyPanel(panels3d, (m) => m.ModelCollidersPanel),
  "model-details": lazyPanel(panels3d, (m) => m.ModelDetailsPanel),
  "skeleton-preview": lazyPanel(panels3d, (m) => m.SkeletonPreviewPanel),
  "skeleton-details": lazyPanel(panels3d, (m) => m.SkeletonDetailsPanel),
  "animation-preview": lazyPanel(panels3d, (m) => m.AnimationPreviewPanel),
  "animation-details": lazyPanel(panels3d, (m) => m.AnimationDetailsPanel),
  "skybox-creator-preview": lazyPanel(renderingPanels, (m) => m.SkyboxCreatorPreviewPanel),
  "skybox-creator-cubemap": lazyPanel(renderingPanels, (m) => m.SkyboxCreatorCubemapPanel),
  "skybox-creator-details": lazyPanel(renderingPanels, (m) => m.SkyboxCreatorDetailsPanel),
  "texture-preview": lazyPanel(panels2d, (m) => m.TexturePreviewPanel),
  "texture-details": lazyPanel(panels2d, (m) => m.TextureDetailsPanel),
  "font-preview": lazyPanel(panels2d, (m) => m.FontPreviewPanel),
  "font-details": lazyPanel(panels2d, (m) => m.FontDetailsPanel),
  "blackboard-keys": lazyPanel(animationAiPanels, (m) => m.BlackboardKeysPanel),
  "blackboard-inspector": lazyPanel(animationAiPanels, (m) => m.BlackboardInspectorPanel),
  "anim-graph-graph": lazyPanel(animationAiPanels, (m) => m.AnimGraphGraphPanel),
  "anim-graph-variables": lazyPanel(animationAiPanels, (m) => m.AnimGraphVariablesPanel),
  "anim-graph-details": lazyPanel(animationAiPanels, (m) => m.AnimGraphDetailsPanel),
  "anim-object-variables": lazyPanel(animationAiPanels, (m) => m.AnimObjectVariablesPanel),
  "behaviour-tree-graph": lazyPanel(animationAiPanels, (m) => m.BehaviourTreeGraphPanel),
  "behaviour-tree-details": lazyPanel(animationAiPanels, (m) => m.BehaviourTreeDetailsPanel),
  "behaviour-tree-blackboard": lazyPanel(animationAiPanels, (m) => m.BehaviourTreeBlackboardPanel),
  "behaviour-tree-compiler-results": lazyPanel(animationAiPanels, (m) => m.BehaviourTreeCompilerResultsPanel),
  "trace-timeline": lazyPanel(dataPanels, (m) => m.TraceTimelinePanel),
  "trace-snapshot": lazyPanel(dataPanels, (m) => m.TraceSnapshotPanel),
  "trace-log": lazyPanel(dataPanels, (m) => m.TraceLogPanel),
  // The Animation Graph's Animation Object mode reuses the shared Class panels, which load with the Scene's.
  "anim-graph-compiler-results": (props: IDockviewPanelProps) => <CompilerResultsPanel {...props} />,
  "anim-object-graph": (props: IDockviewPanelProps) => <GraphPanel {...props} />,
  "anim-object-inspector": (props: IDockviewPanelProps) => <InspectorPanel {...props} />,
} satisfies Record<string, DockPanel>;

export const panelComponents: Record<string, DockPanel> = {
  ...scenePanelComponents,
  ...assetEditorPanelComponents,
};
