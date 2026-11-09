import { EDITOR_COMMANDS, EDITOR_COMMAND_CATEGORIES } from "./editor-keybinds";

export type SettingSearchField = {
  categoryId: string;
  /** The sub-category that holds the control; choosing the result opens it. */
  sectionId?: string;
  sectionTitle?: string;
  label: string;
  targetId?: string;
};

type SearchRow = readonly [label: string, targetId?: string];
type SearchSection = readonly [sectionId: string, sectionTitle: string, rows: readonly SearchRow[]];

/** Keybinds sub-category id for an editor command category ("Content Browser" → "contentBrowser"). */
export function keybindSectionId(category: string): string {
  const [first = "", ...rest] = category.split(/\s+/);
  return first.toLowerCase() + rest.map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join("");
}

function category(categoryId: string, sections: readonly SearchSection[]): SettingSearchField[] {
  return sections.flatMap(([sectionId, sectionTitle, rows]) =>
    rows.map(([label, targetId]) => ({ categoryId, sectionId, sectionTitle, label, targetId })),
  );
}

// Search names describe the visible controls. Targets are their accessible HTML
// IDs, so choosing a result reveals the control without changing its value.
// Section ids and titles match the `SettingsSection`s that render the controls.
export const PROJECT_SETTING_FIELDS: SettingSearchField[] = [
  ...category("general", [
    ["project", "Project", [
      ["Project Version", "settings-project-version"],
      ["Autosave Interval", "settings-autosave-interval"],
    ]],
    ["scripting", "Scripting", [
      ["Compile On Save", "settings-compile-on-save"],
      ["Infinite Loop Detection", "settings-infinite-loop-detection"],
      ["Loop Count", "settings-loop-count"],
      ["Garbage Collection Interval", "settings-garbage-collection-interval"],
    ]],
    ["editorUtilityObjects", "Editor Utility Objects", [["Editor Utility Objects"]]],
  ]),
  ...category("sourceControl", [
    ["repository", "Repository", [
      ["Enable Source Control", "settings-source-control-enabled"],
      ["Repository URL", "settings-source-control-url"],
      ["Branch", "settings-source-control-branch"],
      ["Token", "settings-source-control-token"],
    ]],
    ["locking", "Locking", [
      ["Auto-Lock On First Edit", "settings-source-control-auto-lock"],
      ["Poll Interval", "settings-source-control-poll"],
    ]],
  ]),
  ...category("export", [
    ["gamePackaging", "Game Packaging", [
      ["Bundle Debugger", "setting-export-debugger"],
      ["File Count Warn", "setting-export-file-warn"],
      ["File Count Fail", "setting-export-file-fail"],
    ]],
    ["appIdentity", "App Identity", [
      ["App ID", "setting-app-id"],
      ["Display Name", "setting-app-display-name"],
      ["Build Number", "setting-app-build-number"],
    ]],
    ["alwaysPackageFolders", "Always Package Folders", [["Always Package Folders"]]],
    ["projectBackup", "Project Backup", [["Export Project Backup", "export-project"]]],
  ]),
  ...category("game", [
    ["startup", "Startup", [
      ["Startup Scene", "settings-startup-scene"],
      ["Game Instance", "settings-game-instance"],
    ]],
    ["twoD", "2D", [
      ["Pixels Per Unit", "pixels-per-unit"],
      ["Pixel Perfect", "settings-pixel-perfect"],
      ["Nearest Texture Filtering", "settings-nearest-textures"],
    ]],
    ["sortingLayers", "Sorting Layers", [["Sorting Layers"]]],
  ]),
  ...category("saveGames", [
    ["defaults", "Defaults", [
      ["Default Definition", "settings-save-definition"],
      ["Default Slot", "settings-save-slot"],
      ["Default Profile", "settings-save-profile"],
    ]],
    ["previewSaves", "Preview Saves", [
      ["Wipe Preview Saves On Play", "settings-save-wipe-on-play"],
      ["Preview Saves Import Export Reset"],
    ]],
  ]),
  ...category("physics", [
    ["collisionLayers", "Collision Layers", [["Collision Layers"]]],
    ["collisionPresets", "Collision Presets", [["Collision Presets", "settings-collision-presets"]]],
  ]),
  ...category("focusNavigation", [
    ["input", "Input", [
      ["Focus Navigation", "property-settings-focus-enabled"],
      ["Navigation Input", "property-settings-focus-navigationInputGuid"],
      ["Activate Input", "property-settings-focus-activateInputGuid"],
    ]],
    ["repeat", "Repeat And Wrap", [
      ["Repeat Delay", "property-settings-focus-repeat-delay"],
      ["Repeat Interval", "property-settings-focus-repeat-interval"],
      ["Wrap Navigation", "property-settings-focus-wrap"],
    ]],
  ]),
  ...category("rendering", [
    ["pipeline", "Pipeline", [
      ["Render Mode PBR CEL", "setting-render-mode"],
      ["GPU Backend Auto WebGL2 WebGPU", "project-gpu-backend"],
    ]],
    ["scalability", "Scalability", [
      ["Overall Quality", "quality-all"],
      ["Shadows Quality", "quality-shadows"],
      ["Resolution Quality", "quality-resolution"],
      ["Textures Quality", "quality-textures"],
      ["Geometry Quality", "quality-geometry"],
      ["Water Quality", "quality-water"],
      ["Post Processing Quality", "quality-postprocessing"],
      ["Lighting Quality", "quality-lighting"],
      ["Resolution Scale", "quality-resolution-scale"],
      ["Dynamic Resolution", "quality-resolution-dynamic"],
      ["Minimum Resolution Scale", "quality-resolution-minimum"],
      ["Dynamic Resolution Target FPS", "quality-resolution-target"],
      ["Texture LOD Bias", "quality-textures-lod"],
      ["Texture Anisotropy", "quality-textures-anisotropy"],
      ["Texture Budget MiB", "quality-textures-budget"],
      ["Auto LOD Level Of Detail", "quality-geometry-lod"],
      ["LOD Distance Scale", "quality-geometry-distance"],
      ["Water Shading Detail", "quality-water-shading"],
      ["Water Mesh Density Surface Resolution", "quality-water-mesh"],
      ["Water Contact Resolution Foam", "quality-water-contact"],
      ["Water Refraction", "quality-water-refraction"],
      ["Water Refraction Resolution Scene Copy", "quality-water-refraction-scale"],
      ["Water Reflections Sky Only Screen Space Planar", "quality-water-reflections"],
      ["Water Reflection Steps", "quality-water-reflection-steps"],
      ["Water Planar Resolution Reflection", "quality-water-planar-scale"],
      ["Water FFT Size", "quality-water-fft-size"],
      ["Water FFT Cascades", "quality-water-fft-cascades"],
      ["Post Processing Resolution Scale", "quality-postprocessing-scale"],
      ["Allow Ambient Occlusion Quality", "quality-postprocessing-ambientOcclusion"],
      ["Allow Reflections Quality", "quality-postprocessing-reflections"],
      ["Anti-Aliasing MSAA FXAA", "quality-postprocessing-antialiasing"],
      ["Allow Volumetric Lighting Quality", "quality-postprocessing-volumetricLighting"],
      ["Local Light Budget Auto Manual", "quality-lighting-mode"],
    ]],
    ["shadows", "Shadows", [
      ["Shadow Distance", "project-shadow-distance"],
      ["Local Shadow Light Budget", "project-shadow-maxLocalLights"],
    ]],
    ["environment", "Environment Lighting", [
      ["Image-Based Lighting IBL Environment", "project-environment-enabled"],
      ["Environment Intensity", "project-environment-intensity"],
      ["Environment Rotation", "project-environment-rotationYDegrees"],
      ["CEL Environment Strength", "project-environment-celStrength"],
    ]],
    ["postProcessing", "Post Processing", [
      ["Color Pipeline Legacy Scene Linear", "project-effects-pipeline"],
      ["Tone Mapping", "project-effects-tone-mapping"],
      ["Exposure", "project-effects-exposure"],
      ["Contrast", "project-effects-contrast"],
      ["White Balance Temperature Tint Kelvin", "project-effects-white-balance"],
      ["Bloom", "project-effects-bloom"],
      ["Ambient Occlusion SSAO AO", "project-effects-ambient-occlusion"],
      ["Real-Time Reflections Screen Space SSR", "project-effects-reflections"],
      ["Volumetric Fog Lighting Light Beams Density", "project-effects-volumetric"],
      ["Bloom Threshold", "project-effects-bloom-threshold"],
      ["Bloom Weight", "project-effects-bloom-weight"],
      ["Bloom Kernel", "project-effects-bloom-kernel"],
      ["Bloom Scale", "project-effects-bloom-scale"],
      ["Vignette", "project-effects-vignette"],
      ["Vignette Weight", "project-effects-vignette-weight"],
      ["Vignette Color", "project-effects-vignette-color"],
      ["Color Grading LUT Lookup Table", "project-effects-color-grading"],
      ["FSR Upscaling Render Scale Sharpness Resolution", "project-effects-upscaling"],
    ]],
    ["cel", "CEL Shading", [
      ["CEL Outlines", "project-cel-outlinesEnabled"],
      ["CEL Outline Color", "project-cel-outlineColor"],
      ["CEL Outline Width", "project-cel-outlineWidth"],
      ["CEL Outline Distance Fade", "project-cel-outlineDistanceFadeEnabled"],
      ["CEL Outline Fade Start Distance", "project-cel-outlineFadeStart"],
      ["CEL Outline Fade End Distance", "project-cel-outlineFadeEnd"],
    ]],
    ["resolution", "Resolution", [
      ["Custom Render Resolution", "setting-render-custom"],
      ["Render Width", "setting-render-width"],
      ["Render Height", "setting-render-height"],
      ["Black Bars", "setting-render-black-bars"],
      ["Upscaling", "setting-render-upscaling"],
    ]],
    ["water", "Water", [
      ["Water Blend Distance River Lake Ocean Merge", "setting-water-blend-distance"],
    ]],
    ["playPreview", "Play Preview", [
      ["Play Frame Cap", "setting-play-frame-cap"],
      ["Follow System Aspect Ratio", "setting-play-follow-system"],
      ["Play Aspect Width", "setting-play-aspect-width"],
      ["Play Aspect Height", "setting-play-aspect-height"],
    ]],
  ]),
  ...category("textures", [
    ["encoding", "Encoding", [["Retry Texture Encoding", "retry-texture-encoding"]]],
  ]),
  ...category("fonts", [
    ["defaults", "Defaults", [
      ["Default Font", "settings-default-font"],
      ["Global Fallback", "settings-global-fallback"],
    ]],
  ]),
  ...category("audio", [
    ["mixer", "Mixer", [["Audio Mixer", "settings-audio-mixer"]]],
    ["occlusion", "Occlusion", [["Audio Occlusion", "settings-audio-occlusion"]]],
    ["reverb", "Reverb", [
      ["Reverb Wet Scale", "settings-audio-reverb-wet-scale"],
      ["Reverb Decay Scale", "settings-audio-reverb-decay-scale"],
      ["Reverb Damping Scale", "settings-audio-reverb-damping-scale"],
    ]],
  ]),
  ...category("plugins", [
    ["contentBrowser", "Content Browser", [["Show Plugin Content", "settings-show-plugin-content"]]],
    ["installed", "Installed Plugins", [
      ["New Plugin", "settings-plugin-new"],
      ["Import Plugin", "settings-plugin-import"],
    ]],
  ]),
  ...category("extensions", [
    ["installed", "Installed Extensions", [
      ["New Extension", "settings-extension-new"],
      ["Import Extension", "settings-extension-import"],
      ["GLSL to Material"],
    ]],
  ]),
];

export const ENGINE_SETTING_FIELDS: SettingSearchField[] = [
  ...category("about", [
    ["build", "Build", [["Version And Build"]]],
    ["updates", "Updates", [["Automatic Updates", "setting-automatic-updates"]]],
  ]),
  ...category("packaging", [
    ["macSigning", "macOS Signing", [
      ["Signing Identity", "setting-mac-signing-identity"],
      ["Notarization Profile", "setting-mac-notary-profile"],
    ]],
  ]),
  ...category("interface", [
    ["density", "Density", [["Compact Mode", "setting-compact-mode"]]],
  ]),
  ...category("undo", [
    ["history", "History", [
      ["Undo History Length", "setting-undo-length"],
      ["Undo Memory Limit (MB)", "setting-undo-memory-mb"],
    ]],
  ]),
  ...category("debugger", [
    ["diagnostics", "Diagnostics", [
      ["Debug Mode", "setting-debug-mode"],
      ["Trace Graphics Errors", "setting-trace-graphics-errors"],
    ]],
    ["simulation", "Simulation", [["Keep Simulation Changes", "setting-keep-simulation-changes"]]],
    ["session", "Session", [
      ["Pause On Errors", "setting-pause-simulation-on-errors"],
      ["Pause On Play", "setting-pause-on-play"],
    ]],
    ["profiler", "Profiler", [
      ["Recording Duration (Seconds)", "setting-profile-duration"],
      ["GPU Timing", "setting-profile-gpu"],
      ["Profile Retained Data Budget (MiB)", "setting-profile-budget-mib"],
    ]],
    ["trace", "Trace", [
      ["Trace Memory Budget (MiB)", "setting-trace-budget-mib"],
      ["Traces Kept", "setting-traces-kept"],
    ]],
  ]),
  ...category("viewport", [
    ["renderingOverrides", "Rendering Overrides", [
      ["Override Project Rendering", "setting-rendering-overrides"],
      ["Hardware Scaling Level", "setting-hardware-scale"],
      ["Post-Processing", "setting-post-processing"],
    ]],
    ["culling", "Culling", [
      ["Occlusion Culling", "setting-viewport-occlusion-culling"],
    ]],
    ["frameRate", "Frame Rate", [
      ["Viewport Frame Cap", "setting-frame-cap"],
      ["Camera Preview Frame Rate", "setting-camera-preview-frame-rate"],
    ]],
    ["cameraPlacement", "Camera And Placement", [
      ["Camera Speed", "setting-fly-speed"],
      ["Drop Distance", "setting-drop-distance"],
      ["Place On Surfaces", "setting-place-on-surfaces"],
      ["Placement Trace Distance", "setting-placement-distance"],
    ]],
  ]),
  ...category("graph", [
    ["connections", "Connections", [
      ["Node Connection Assistant", "setting-graph-assistant"],
      ["Connection Distance (Pixels)", "setting-graph-distance"],
      ["Shake Nodes To Disconnect", "setting-graph-shake"],
    ]],
    ["addNode", "Add Node", [
      ["Add Node History", "setting-graph-add-node-history"],
      ["Clear Add Node History", "setting-graph-add-node-history-clear"],
    ]],
    ["canvas", "Canvas", [
      ["Graph Default Zoom", "setting-graph-default-zoom"],
      ["Read-Only Pin Defaults", "setting-read-only-pin-defaults"],
    ]],
  ]),
  ...category("assets", [
    ["import", "Import", [
      ["Model Import Default Scale", "setting-model-import-scale"],
      ["HDR Import Face Size", "setting-hdr-import-face-size"],
    ]],
    ["editorTextures", "Editor Textures", [
      ["Editor Texture LOD", "setting-editor-texture-lod"],
      ["Editor Texture LOD Quality", "setting-editor-texture-lod-quality"],
      ["Texture Budget", "setting-texture-budget"],
      ["Texture Budget MB", "setting-texture-budget-mb"],
    ]],
    ["audio", "Audio", [
      ["Audio Budget", "setting-audio-budget"],
      ["Audio Budget MB", "setting-audio-budget-mb"],
      ["Audio Max Voices", "setting-audio-max-voices"],
    ]],
  ]),
  ...category("thumbnails", [
    ["generation", "Generation", [["Generate Thumbnails", "setting-thumbnails"]]],
  ]),
  ...category("extensions", [
    ["library", "Library", [["Engine Extensions"]]],
  ]),
  { categoryId: "focus", label: "Keep Panels In Focus Mode" },
  ...category("keybinds", EDITOR_COMMAND_CATEGORIES.map((group) => [
    keybindSectionId(group),
    group,
    EDITOR_COMMANDS
      .filter((command) => command.category === group)
      .map((command) => [command.label, `keybind-${command.id}-record`] as const),
  ] as const)),
];
