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

export type DocumentKind = "content-browser" | AssetDocumentKind;

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

export function assetTypeForDocumentKind(kind: AssetDocumentKind): string {
  switch (kind) {
    case "scene":
      return "Scene";
    case "scene-layer":
      return "SceneLayer";
    case "graph":
      return "Class";
    case "prefab":
      return "Prefab";
    case "font":
      return "Font";
    case "sprite":
      return "Sprite";
    case "sprite-animation":
      return "SpriteAnimation";
    case "anim-graph-3d":
      return "AnimationGraph3D";
    case "anim-graph-2d":
      return "AnimationGraph2D";
    case "behaviour-tree":
      return "BehaviourTree";
    case "blackboard":
      return "Blackboard";
    case "save-game":
      return "SaveGame";
    case "material":
      return "Material";
    case "material-function":
      return "MaterialFunction";
    case "material-instance":
      return "MaterialInstance";
    case "tileset":
      return "Tileset";
    case "tilemap":
      return "Tilemap";
    case "enum":
      return "Enum";
    case "structure":
      return "Structure";
    case "data-definition":
      return "DataDefinition";
    case "data-tree":
      return "DataTree";
    case "global-parameter-collection":
      return "GlobalParameterCollection";
    case "float-curve":
      return "FloatCurve";
    case "vector-curve":
      return "VectorCurve";
    case "color-curve":
      return "ColorCurve";
    case "timeline":
      return "Timeline";
    case "timeline-clip-2d":
      return "TimelineClip2D";
    case "timeline-clip-3d":
      return "TimelineClip3D";
    case "script-interface":
      return "ScriptInterface";
    case "plugin-settings":
      return "PluginSettings";
    case "audio":
      return "Audio";
    case "input-action":
      return "InputAction";
    case "input-axis":
      return "InputAxis";
    case "audio-mixer":
      return "AudioMixer";
    case "audio-channel":
      return "AudioChannel";
    case "sound-attenuation":
      return "SoundAttenuation";
    case "camera-shake":
      return "CameraShake";
    case "particle-emitter":
      return "ParticleEmitter";
    case "particle-graph":
      return "ParticleGraph";
    case "particle-system":
      return "ParticleSystem";
    case "water":
      return "Water";
    case "model":
      return "Model";
    case "skeleton":
      return "Skeleton";
    case "animation":
      return "Animation";
    case "skybox-creator":
      return "SkyboxCreator";
    case "trace":
      return "Trace";
    case "texture":
      return "Texture";
    case "render-target":
      return "RenderTarget";
    case "render-target-texture":
      return "RenderTargetTexture";
    // Each extension asset keeps its own header type; this placeholder is never written.
    case "extension-asset":
      return "ExtensionAsset";
  }
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
  if (ref.kind === "content-browser") {
    return CONTENT_BROWSER_ID;
  }
  return `${ref.kind}:${ref.path}`;
}

export function parseDocumentId(
  id: string,
): { kind: DocumentKind; path: string } | null {
  if (id === CONTENT_BROWSER_ID) {
    return { kind: "content-browser", path: "" };
  }
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon);
  if (!isAssetDocumentKind(kind)) return null;
  return { kind, path: id.slice(colon + 1) };
}

export function isContentBrowserId(id: string): boolean {
  return id === CONTENT_BROWSER_ID;
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
        /\.(inputaction|inputaxis|scene|scenelayer|prefab|spriteanim|sprite|anim|material|matfunc|matinst|class|tileset|tilemap|datadefinition|datatree|plugin|mixer|channel|atten|shake|emitter|particlegraph|particles|skyboxcreator|rendertargettexture|rendertarget|savegame|bt|blackboard|water|globalparams)\.hasset$/i,
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
