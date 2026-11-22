import type { SerializedGraph } from "./project";
import type { SerializedScene } from "./scene";

export const ASSET_DOCUMENT_KINDS = [
  "scene",
  "scene-layer",
  "graph",
  "prefab",
  "font",
  "sprite",
  "sprite-animation",
  "anim-graph-3d",
  "anim-graph-2d",
  "blend-space",
  "sprite-blend-space",
  "behaviour-tree",
  "blackboard",
  "save-game",
  "material",
  "material-function",
  "material-instance",
  "tileset",
  "tilemap",
  "enum",
  "structure",
  "data-definition",
  "data-tree",
  "float-curve",
  "vector-curve",
  "color-curve",
  "global-parameter-collection",
  "timeline",
  "timeline-clip-2d",
  "timeline-clip-3d",
  "script-interface",
  "plugin-settings",
  "audio",
  "input-action",
  "input-axis",
  "audio-mixer",
  "audio-channel",
  "sound-attenuation",
  "camera-shake",
  "particle-emitter",
  "particle-graph",
  "particle-system",
  "water",
  "model",
  "skeleton",
  "animation",
  "skybox-creator",
  "trace",
  "texture",
  "render-target",
  "render-target-texture",
  "extension-asset",
] as const;

export type AssetDocumentKind = (typeof ASSET_DOCUMENT_KINDS)[number];

/** Pinned chrome tabs with no asset behind them: never closed by the user, never saved. */
export type ChromeDocumentKind = "content-browser" | "source-control";

/**
 * Closable tabs with no asset behind them that live only for the session: never dirty, saved,
 * persisted in `layout.json` or restored. The Text Editor tab edits one Inspector field full size.
 */
export type TransientDocumentKind = "text-editor";

export type DocumentKind = ChromeDocumentKind | TransientDocumentKind | AssetDocumentKind;

/**
 * 3D and 2D Animation Graph assets: one editor and one document shape. A 3D graph plays Animations on its Skeleton
 * and passes poses; a 2D graph plays Sprite Animations and passes frames. The two types never convert.
 */
export const ANIM_GRAPH_ASSET_TYPES = ["AnimationGraph3D", "AnimationGraph2D"] as const;
export type AnimGraphAssetType = (typeof ANIM_GRAPH_ASSET_TYPES)[number];
export type AnimGraphDocumentKind = "anim-graph-3d" | "anim-graph-2d";

export function isAnimGraphAssetType(type: string | null | undefined): type is AnimGraphAssetType {
  return type === "AnimationGraph3D" || type === "AnimationGraph2D";
}

export function isAnimGraphDocumentKind(kind: string | null | undefined): kind is AnimGraphDocumentKind {
  return kind === "anim-graph-3d" || kind === "anim-graph-2d";
}

export const CONTENT_BROWSER_ID = "content-browser";

export const CONTENT_BROWSER_REF: DocumentRef = {
  kind: "content-browser",
  path: "",
  label: "Content Browser",
};

/** Shown while the project's source control mode is not Off. */
export const SOURCE_CONTROL_ID = "source-control";

export const SOURCE_CONTROL_REF: DocumentRef = {
  kind: "source-control",
  path: "",
  label: "Source Control",
};

export function isChromeDocumentKind(kind: string): kind is ChromeDocumentKind {
  return kind === "content-browser" || kind === "source-control";
}

/** Content Browser and Source Control: pinned tabs the user cannot close. */
export function isChromeDocumentId(id: string): boolean {
  return id === CONTENT_BROWSER_ID || id === SOURCE_CONTROL_ID;
}

export function isTransientDocumentKind(kind: string): kind is TransientDocumentKind {
  return kind === "text-editor";
}

/** A transient tab's id (`text-editor:<session>`): closable, never persisted or restored. */
export function isTransientDocumentId(id: string): boolean {
  return id.startsWith("text-editor:");
}

export interface DocumentRef {
  kind: DocumentKind;
  path: string;
  label: string;
}

const KIND_SET = new Set<string>(ASSET_DOCUMENT_KINDS);

export function isAssetDocumentKind(
  kind: string,
): kind is AssetDocumentKind {
  return KIND_SET.has(kind);
}

/** World Scene and SceneLayer overlay documents share the viewport / outliner / details shell. */
export function isSceneWorkspaceKind(
  kind: string | undefined,
): kind is "scene" | "scene-layer" {
  return kind === "scene" || kind === "scene-layer";
}

/**
 * The header type each asset document kind reads and writes. `extension-asset` is a placeholder: each extension
 * asset keeps its own `extension.<guid>.<typeId>` header type, and this one is never written.
 */
const ASSET_TYPE_BY_DOCUMENT_KIND = {
  scene: "Scene",
  "scene-layer": "SceneLayer",
  graph: "Class",
  prefab: "Prefab",
  font: "Font",
  sprite: "Sprite",
  "sprite-animation": "SpriteAnimation",
  "anim-graph-3d": "AnimationGraph3D",
  "blend-space": "BlendSpace",
  "sprite-blend-space": "SpriteBlendSpace",
  "anim-graph-2d": "AnimationGraph2D",
  "behaviour-tree": "BehaviourTree",
  blackboard: "Blackboard",
  "save-game": "SaveGame",
  material: "Material",
  "material-function": "MaterialFunction",
  "material-instance": "MaterialInstance",
  tileset: "Tileset",
  tilemap: "Tilemap",
  enum: "Enum",
  structure: "Structure",
  "data-definition": "DataDefinition",
  "data-tree": "DataTree",
  "global-parameter-collection": "GlobalParameterCollection",
  "float-curve": "FloatCurve",
  "vector-curve": "VectorCurve",
  "color-curve": "ColorCurve",
  timeline: "Timeline",
  "timeline-clip-2d": "TimelineClip2D",
  "timeline-clip-3d": "TimelineClip3D",
  "script-interface": "ScriptInterface",
  "plugin-settings": "PluginSettings",
  audio: "Audio",
  "input-action": "InputAction",
  "input-axis": "InputAxis",
  "audio-mixer": "AudioMixer",
  "audio-channel": "AudioChannel",
  "sound-attenuation": "SoundAttenuation",
  "camera-shake": "CameraShake",
  "particle-emitter": "ParticleEmitter",
  "particle-graph": "ParticleGraph",
  "particle-system": "ParticleSystem",
  water: "Water",
  model: "Model",
  skeleton: "Skeleton",
  animation: "Animation",
  "skybox-creator": "SkyboxCreator",
  trace: "Trace",
  texture: "Texture",
  "render-target": "RenderTarget",
  "render-target-texture": "RenderTargetTexture",
  "extension-asset": "ExtensionAsset",
} as const satisfies Record<AssetDocumentKind, string>;

/** Every built-in asset header type. Extension asset types (`extension.<guid>.<typeId>`) are not in the union. */
export type AssetType = Exclude<(typeof ASSET_TYPE_BY_DOCUMENT_KIND)[AssetDocumentKind], "ExtensionAsset">;

export function assetTypeForDocumentKind<Kind extends AssetDocumentKind>(kind: Kind): (typeof ASSET_TYPE_BY_DOCUMENT_KIND)[Kind] {
  return ASSET_TYPE_BY_DOCUMENT_KIND[kind];
}

/** Header types an extension declares: `extension.<extensionGuid>.<typeId>`. */
export const EXTENSION_ASSET_TYPE_PREFIX = "extension.";

export function extensionAssetType(extensionGuid: string, typeId: string): string {
  return `${EXTENSION_ASSET_TYPE_PREFIX}${extensionGuid}.${typeId}`;
}

export function isExtensionAssetType(type: string): boolean {
  return type.startsWith(EXTENSION_ASSET_TYPE_PREFIX);
}

export function documentKindForAssetType(type: string): AssetDocumentKind | null {
  if (isExtensionAssetType(type)) return "extension-asset";
  switch (type) {
    case "Scene":
      return "scene";
    case "SceneLayer":
      return "scene-layer";
    case "Class":
      return "graph";
    case "Prefab":
      return "prefab";
    case "Font":
      return "font";
    case "Sprite":
      return "sprite";
    case "SpriteAnimation":
      return "sprite-animation";
    case "AnimationGraph3D":
      return "anim-graph-3d";
    case "BlendSpace":
      return "blend-space";
    case "SpriteBlendSpace":
      return "sprite-blend-space";
    case "AnimationGraph2D":
      return "anim-graph-2d";
    case "BehaviourTree":
      return "behaviour-tree";
    case "Blackboard":
      return "blackboard";
    case "SaveGame":
      return "save-game";
    case "Material":
      return "material";
    case "MaterialFunction":
      return "material-function";
    case "MaterialInstance":
      return "material-instance";
    case "Tileset":
      return "tileset";
    case "Tilemap":
      return "tilemap";
    case "Enum":
      return "enum";
    case "Structure":
      return "structure";
    case "DataDefinition":
      return "data-definition";
    case "DataTree":
      return "data-tree";
    case "GlobalParameterCollection":
      return "global-parameter-collection";
    case "FloatCurve":
      return "float-curve";
    case "VectorCurve":
      return "vector-curve";
    case "ColorCurve":
      return "color-curve";
    case "Timeline":
      return "timeline";
    case "TimelineClip2D":
      return "timeline-clip-2d";
    case "TimelineClip3D":
      return "timeline-clip-3d";
    case "ScriptInterface":
      return "script-interface";
    case "PluginSettings":
      return "plugin-settings";
    case "Audio":
      return "audio";
    case "InputAction":
      return "input-action";
    case "InputAxis":
      return "input-axis";
    case "AudioMixer":
      return "audio-mixer";
    case "AudioChannel":
      return "audio-channel";
    case "SoundAttenuation":
      return "sound-attenuation";
    case "CameraShake":
      return "camera-shake";
    case "ParticleEmitter":
      return "particle-emitter";
    case "ParticleGraph":
      return "particle-graph";
    case "ParticleSystem":
      return "particle-system";
    case "Water":
      return "water";
    case "SkyboxCreator":
      return "skybox-creator";
    case "Trace":
      return "trace";
    case "Model":
      return "model";
    case "Skeleton":
      return "skeleton";
    case "Animation":
      return "animation";
    case "Texture":
      return "texture";
    case "RenderTarget":
      return "render-target";
    case "RenderTargetTexture":
      return "render-target-texture";
    default:
      return null;
  }
}

export function documentKindLabel(kind: AssetDocumentKind): string {
  switch (kind) {
    case "scene":
      return "Scene";
    case "scene-layer":
      return "Scene Layer";
    case "graph":
      return "Class";
    case "prefab":
      return "Prefab";
    case "font":
      return "Font";
    case "sprite":
      return "Sprite";
    case "sprite-animation":
      return "Sprite Animation";
    case "anim-graph-3d":
      return "3D Animation Graph";
    case "blend-space":
      return "Blend Space";
    case "sprite-blend-space":
      return "Sprite Blend Space";
    case "anim-graph-2d":
      return "2D Animation Graph";
    case "behaviour-tree":
      return "Behaviour Tree";
    case "blackboard":
      return "Blackboard";
    case "material":
      return "Material";
    case "material-function":
      return "Material Function";
    case "material-instance":
      return "Material Instance";
    case "tileset":
      return "Tileset";
    case "tilemap":
      return "Tilemap";
    case "enum":
      return "Enum";
    case "structure":
      return "Structure";
    case "data-definition":
      return "Data Definition";
    case "data-tree":
      return "Data Tree";
    case "global-parameter-collection":
      return "Global Parameter Collection";
    case "float-curve":
      return "Float Curve";
    case "vector-curve":
      return "Vector Curve";
    case "color-curve":
      return "Color Curve";
    case "timeline":
      return "Timeline";
    case "timeline-clip-2d":
      return "2D Timeline Clip";
    case "timeline-clip-3d":
      return "3D Timeline Clip";
    case "script-interface":
      return "Script Interface";
    case "plugin-settings":
      return "Plugin Settings";
    case "audio":
      return "Audio";
    case "input-action":
      return "Input Action";
    case "save-game":
      return "Save Game";
    case "input-axis":
      return "Input Axis";
    case "audio-mixer":
      return "Audio Mixer";
    case "audio-channel":
      return "Audio Channel";
    case "sound-attenuation":
      return "Sound Attenuation";
    case "camera-shake":
      return "Camera Shake";
    case "particle-emitter":
      return "Particle Emitter";
    case "particle-graph":
      return "Particle Graph";
    case "particle-system":
      return "Particle System";
    case "water":
      return "Water";
    case "model":
      return "Model";
    case "skeleton":
      return "Skeleton";
    case "animation":
      return "Animation";
    case "skybox-creator":
      return "Skybox Creator";
    case "trace":
      return "Trace";
    case "texture":
      return "Texture";
    case "render-target":
      return "Render Target";
    case "render-target-texture":
      return "Render Target Texture";
    case "extension-asset":
      return "Extension Asset";
  }
}

export function documentId(ref: Pick<DocumentRef, "kind" | "path">): string {
  if (isChromeDocumentKind(ref.kind)) return ref.kind;
  // Transient kinds carry their session id in `path`.
  return `${ref.kind}:${ref.path}`;
}

/** A persisted document id's kind and path; transient ids parse as null, so they are never restored. */
export function parseDocumentId(
  id: string,
): { kind: DocumentKind; path: string } | null {
  if (isChromeDocumentId(id)) {
    return { kind: id as ChromeDocumentKind, path: "" };
  }
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon);
  if (!isAssetDocumentKind(kind)) return null;
  return { kind, path: id.slice(colon + 1) };
}

export type DockWindowDirection = "left" | "right" | "above" | "below" | "within";

/** Last dock location of a closed panel, keyed later by document id then panel id. */
export interface PanelPlacement {
  referencePanelId: string;
  direction: DockWindowDirection;
  width?: number;
  height?: number;
}

export interface ProjectLayouts {
  /** Asset identities let saved tabs follow renames and moves. Keys are document ids. */
  assetGuids?: Record<string, string>;
  documents: Record<string, Record<string, unknown>>;
  tabOrder: string[];
  activeDocumentId?: string | null;
  panelPlacements?: Record<string, Record<string, PanelPlacement>>;
  /** Content Browser visibility filter for mounted plugin roots. Default off. */
  showPluginContent?: boolean;
}

export function createEmptyLayouts(): ProjectLayouts {
  return {
    documents: {},
    tabOrder: [],
    activeDocumentId: null,
    showPluginContent: false,
  };
}

export function labelFromPath(path: string): string {
  const base =
    path
      .split("/")
      .pop()
      ?.replace(
        /\.(inputaction|inputaxis|scene|scenelayer|prefab|spriteanim|sprite|anim3d|anim2d|blendspace|spriteblend|anim|material|matfunc|matinst|class|tileset|tilemap|datadefinition|datatree|plugin|mixer|channel|atten|shake|emitter|particlegraph|particles|skyboxcreator|rendertargettexture|rendertarget|savegame|bt|blackboard|water|globalparams)\.hasset$/i,
        "",
      )
      .replace(/\.hasset$/i, "")
      .replace(/\.htrace$/i, "") ?? path;
  return base
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createDocumentRef(
  kind: AssetDocumentKind,
  path: string,
  content?: SerializedScene | SerializedGraph | { name?: string },
): DocumentRef {
  const named =
    content && typeof content === "object" && "name" in content
      ? content.name
      : undefined;
  const fromPath = labelFromPath(path);
  const namedLabel =
    typeof named === "string" && named.trim() !== "" ? named.trim() : "";
  const baseLabel =
    kind === "scene"
      ? fromPath.trim() !== ""
        ? fromPath
        : namedLabel || fromPath
      : namedLabel || fromPath;
  return { kind, path, label: `${baseLabel} ${documentKindLabel(kind)}` };
}
