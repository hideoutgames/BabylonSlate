import type { SerializedGraph } from "./project";
import type { SerializedScene } from "./scene";

export const ASSET_DOCUMENT_KINDS = [
  "scene",
  "scene-layer",
  "graph",
  "font",
  "sprite",
  "sprite-animation",
  "anim-graph",
  "behaviour-tree",
  "blackboard",
  "material",
  "material-function",
  "tileset",
  "tilemap",
  "enum",
  "structure",
  "script-interface",
  "plugin-settings",
  "audio",
  "audio-mixer",
  "audio-channel",
  "sound-attenuation",
  "particle-emitter",
  "particle-system",
  "model",
  "skeleton",
  "animation",
  "skybox-creator",
  "trace",
  "asset-settings",
] as const;

export type AssetDocumentKind = (typeof ASSET_DOCUMENT_KINDS)[number];

export type DocumentKind = "content-browser" | AssetDocumentKind;

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
    case "font":
      return "Font";
    case "sprite":
      return "Sprite";
    case "sprite-animation":
      return "SpriteAnimation";
    case "anim-graph":
      return "AnimationGraph";
    case "behaviour-tree":
      return "BehaviourTree";
    case "blackboard":
      return "Blackboard";
    case "material":
      return "Material";
    case "material-function":
      return "MaterialFunction";
    case "tileset":
      return "Tileset";
    case "tilemap":
      return "Tilemap";
    case "enum":
      return "Enum";
    case "structure":
      return "Structure";
    case "script-interface":
      return "ScriptInterface";
    case "plugin-settings":
      return "PluginSettings";
    case "audio":
      return "Audio";
    case "audio-mixer":
      return "AudioMixer";
    case "audio-channel":
      return "AudioChannel";
    case "sound-attenuation":
      return "SoundAttenuation";
    case "particle-emitter":
      return "ParticleEmitter";
    case "particle-system":
      return "ParticleSystem";
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
    case "asset-settings":
      return "Texture";
  }
}

/**
 * A legacy `Shader` asset opens as a Material document and is rewritten to the
 * canonical `Material` header type on save, which the migrate-on-save approval
 * flow gates. Its `.shader.babasset` path is deliberately left alone so open
 * documents, layout ids, references and source-control locks stay valid.
 */
export function assetTypeForDocumentSave(
  kind: AssetDocumentKind,
  existingType?: string | null,
): string {
  void existingType;
  return assetTypeForDocumentKind(kind);
}

/** Header types that open as a Material document. */
export const LEGACY_MATERIAL_ASSET_TYPES = ["Shader", "ShaderGraph"] as const;

export function isLegacyMaterialAssetType(type: string): boolean {
  return (LEGACY_MATERIAL_ASSET_TYPES as readonly string[]).includes(type);
}

export function documentKindForAssetType(type: string): AssetDocumentKind | null {
  switch (type) {
    case "Scene":
      return "scene";
    case "SceneLayer":
      return "scene-layer";
    case "Graph":
    case "Class":
      return "graph";
    case "Font":
      return "font";
    case "Sprite":
      return "sprite";
    case "SpriteAnimation":
      return "sprite-animation";
    case "AnimationGraph":
      return "anim-graph";
    case "BehaviourTree":
      return "behaviour-tree";
    case "Blackboard":
      return "blackboard";
    case "Material":
    case "Shader":
    case "ShaderGraph":
      return "material";
    case "MaterialFunction":
      return "material-function";
    case "Tileset":
      return "tileset";
    case "Tilemap":
      return "tilemap";
    case "Enum":
      return "enum";
    case "Structure":
      return "structure";
    case "ScriptInterface":
      return "script-interface";
    case "PluginSettings":
      return "plugin-settings";
    case "Audio":
      return "audio";
    case "AudioMixer":
      return "audio-mixer";
    case "AudioChannel":
      return "audio-channel";
    case "SoundAttenuation":
      return "sound-attenuation";
    case "ParticleEmitter":
      return "particle-emitter";
    case "ParticleSystem":
      return "particle-system";
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
      return "asset-settings";
    default:
      return null;
  }
}

export function isLogicGraphAssetType(type: string): boolean {
  return type === "Class" || type === "Graph";
}

export function documentKindLabel(kind: AssetDocumentKind): string {
  switch (kind) {
    case "scene":
      return "Scene";
    case "scene-layer":
      return "Scene Layer";
    case "graph":
      return "Class";
    case "font":
      return "Font";
    case "sprite":
      return "Sprite";
    case "sprite-animation":
      return "Sprite Animation";
    case "anim-graph":
      return "Anim Graph";
    case "behaviour-tree":
      return "Behaviour Tree";
    case "blackboard":
      return "Blackboard";
    case "material":
      return "Material";
    case "material-function":
      return "Material Function";
    case "tileset":
      return "Tileset";
    case "tilemap":
      return "Tilemap";
    case "enum":
      return "Enum";
    case "structure":
      return "Structure";
    case "script-interface":
      return "Script Interface";
    case "plugin-settings":
      return "Plugin Settings";
    case "audio":
      return "Audio";
    case "audio-mixer":
      return "Audio Mixer";
    case "audio-channel":
      return "Audio Channel";
    case "sound-attenuation":
      return "Sound Attenuation";
    case "particle-emitter":
      return "Particle Emitter";
    case "particle-system":
      return "Particle System";
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
    case "asset-settings":
      return "Settings";
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

/**
 * Reopen a layout.json `asset-settings:…` tab as the current document kind
 * when the registry type has since gained its own DockView (Model).
 */
export function migrateRestoredDocumentId(
  id: string,
  typeForPath: (path: string) => string | null | undefined,
): string {
  const parsed = parseDocumentId(id);
  if (!parsed || parsed.kind !== "asset-settings") return id;
  const type = typeForPath(parsed.path);
  if (!type) return id;
  const kind = documentKindForAssetType(type);
  if (!kind || kind === parsed.kind) return id;
  return documentId({ kind, path: parsed.path });
}

export function isContentBrowserId(id: string): boolean {
  return id === CONTENT_BROWSER_ID;
}

export function isClosableDocumentKind(kind: DocumentKind): boolean {
  return kind !== "content-browser";
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

export function migrateLegacyLayout(
  legacy: Record<string, unknown>,
  mainSceneId: string,
): ProjectLayouts {
  return {
    documents: { [mainSceneId]: legacy },
    tabOrder: [mainSceneId],
    activeDocumentId: mainSceneId,
  };
}

export function labelFromPath(path: string): string {
  const base =
    path
      .split("/")
      .pop()
      ?.replace(
        /\.(scene|scenelayer|graph|eui|ui|spriteanim|sprite|anim|shader|material|matfunc|class|tileset|tilemap|plugin|mixer|channel|atten|emitter|particles|skyboxcreator)\.(babasset|json)$/i,
        "",
      )
      .replace(/\.babasset$/i, "")
      .replace(/\.babtrace$/i, "") ?? path;
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
