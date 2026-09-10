export type SettingSearchField = {
  categoryId: string;
  label: string;
  targetId?: string;
};

function fields(
  rows: readonly (readonly [string, string, string?])[],
): SettingSearchField[] {
  return rows.map(([categoryId, label, targetId]) => ({
    categoryId,
    label,
    targetId,
  }));
}

// Search names describe the visible controls. Targets are their accessible HTML
// IDs, so choosing a result reveals the control without changing its value.
export const PROJECT_SETTING_FIELDS = fields([
  ["general", "Project Name"],
  ["general", "Version"],
  ["general", "Touch Target Minimum"],
  ["general", "Compile On Save", "settings-compile-on-save"],
  ["general", "Infinite Loop Detection", "settings-infinite-loop-detection"],
  ["general", "Loop Count", "settings-loop-count"],
  ["general", "Autosave Interval", "settings-autosave-interval"],
  ["general", "Editor Utility Objects"],
  ["twoD", "Pixels Per Unit", "pixels-per-unit"],
  ["twoD", "Pixel Perfect", "settings-pixel-perfect"],
  ["twoD", "Integer Zoom", "settings-integer-zoom"],
  ["twoD", "Sorting Layers"],
  ["physics", "Collision Layers"],
  ["fonts", "Default Font", "settings-default-font"],
  ["fonts", "Global Fallback", "settings-global-fallback"],
  ["audio", "Audio Mixer", "settings-audio-mixer"],
  ["audio", "Audio Occlusion", "settings-audio-occlusion"],
  ["audio", "Reverb Wet Scale", "settings-audio-reverb-wet-scale"],
  ["audio", "Reverb Decay Scale", "settings-audio-reverb-decay-scale"],
  ["audio", "Reverb Damping Scale", "settings-audio-reverb-damping-scale"],
  ["rendering", "Play Frame Cap", "setting-play-frame-cap"],
  ["rendering", "Follow System Aspect Ratio", "setting-play-follow-system"],
  ["rendering", "Play Aspect Width", "setting-play-aspect-width"],
  ["rendering", "Play Aspect Height", "setting-play-aspect-height"],
  ["rendering", "Custom Render Resolution", "setting-render-custom"],
  ["rendering", "Render Width", "setting-render-width"],
  ["rendering", "Render Height", "setting-render-height"],
  ["rendering", "Black Bars", "setting-render-black-bars"],
  ["textures", "Texture Policy"],
  ["textures", "Retry Texture Encoding", "retry-texture-encoding"],
  ["plugins", "Show Plugin Content", "settings-show-plugin-content"],
  ["plugins", "New Plugin", "settings-plugin-new"],
  ["plugins", "Import Plugin", "settings-plugin-import"],
  ["export", "Startup Scene", "settings-startup-scene"],
  ["export", "Game Instance", "settings-game-instance"],
  ["export", "Packed", "setting-export-packed"],
  ["export", "Bundle Debugger", "setting-export-debugger"],
  ["export", "File Count Warn", "setting-export-file-warn"],
  ["export", "File Count Fail", "setting-export-file-fail"],
  ["export", "Export Game", "export-game"],
  ["export", "Export Project Backup", "export-project"],
  ["sourceControl", "Enable Source Control", "settings-source-control-enabled"],
  ["sourceControl", "Repository URL", "settings-source-control-url"],
  ["sourceControl", "Branch", "settings-source-control-branch"],
  [
    "sourceControl",
    "Auto-Lock On First Edit",
    "settings-source-control-auto-lock",
  ],
  ["sourceControl", "Poll Interval", "settings-source-control-poll"],
  ["sourceControl", "Token", "settings-source-control-token"],
]);

export const ENGINE_SETTING_FIELDS = fields([
  ["about", "Version And Build"],
  ["appearance", "Theme", "setting-theme"],
  ["appearance", "Pointer Target Scale", "setting-pointer-scale"],
  ["undo", "Undo History Length", "setting-undo-length"],
  ["viewport", "Viewport Frame Cap", "setting-frame-cap"],
  ["viewport", "Camera Speed", "setting-fly-speed"],
  ["viewport", "Hardware Scaling Level", "setting-hardware-scale"],
  ["viewport", "Post-Processing", "setting-post-processing"],
  ["assets", "Model Import Default Scale", "setting-model-import-scale"],
  ["assets", "Editor Texture LOD", "setting-editor-texture-lod"],
  [
    "assets",
    "Editor Texture LOD Quality",
    "setting-editor-texture-lod-quality",
  ],
  ["assets", "Texture Budget", "setting-texture-budget"],
  ["assets", "Texture Budget MB", "setting-texture-budget-mb"],
  ["assets", "Audio Budget", "setting-audio-budget"],
  ["assets", "Audio Budget MB", "setting-audio-budget-mb"],
  ["assets", "Audio Max Voices", "setting-audio-max-voices"],
  ["graph", "Graph Default Zoom", "setting-graph-default-zoom"],
  ["thumbnails", "Generate Thumbnails", "setting-thumbnails"],
  ["templates", "Templates Folder", "setting-templates-folder"],
  ["focus", "Keep Panels In Focus Mode"],
]);
