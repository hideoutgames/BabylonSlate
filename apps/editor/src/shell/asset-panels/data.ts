// One lazily loaded panel family (`panel-registry.tsx`): Data, Save Game, Input, Plugin Settings, Global Parameter Collection, Curve, Timeline, Audio and Trace windows.
export { DataDefinitionDetailsPanel, DataDefinitionFieldsPanel } from "../../panels/data-definition-panel";
export { DataTreeEntriesPanel, DataTreeHierarchyPanel, DataTreeValidationPanel, DataTreeValuesPanel } from "../../panels/data-asset-panels";
export { SaveGameDefinitionPanel, SaveGameFieldsPanel } from "../../panels/save-game-panels";
export { InputBindingDetailsPanel, InputBindingsPanel } from "../../panels/input-asset-panels";
export { PluginSettingsDetailsPanel } from "../../panels/plugin-settings-details-panel";
export { GlobalParameterCollectionPanel } from "../../components/global-parameter-collection-editor";
export { CurveAssetDetailsPanel, CurveAssetEditorPanel } from "../../components/curve-asset-editor";
export { TimelineAssetClipsPanel, TimelineAssetEventsPanel } from "../../components/timeline-asset-editor";
export { TimelineClipInspectorPanel, TimelineClipProxiesPanel, TimelineClipTimelinePanel } from "../../components/timeline-clip-asset-editor";
export { TimelineClipPreviewPanel } from "../../panels/timeline-clip-preview-panel";
export { AudioClipsPanel, AudioDetailsPanel, AudioPreviewPanel } from "../../components/audio-editor";
export { AudioChannelDetailsPanel, AudioMixerDetailsPanel, SoundAttenuationDetailsPanel } from "../../components/audio-asset-editor";
export { TraceLogPanel, TraceSnapshotPanel, TraceTimelinePanel } from "../../components/trace-editor";
