import type { SerializedGraph } from "./project";
import type { SerializedScene } from "./scene";

export const ASSET_DOCUMENT_KINDS = [
  "scene",
  "graph",
  "ui",
  "font",
  "sprite",
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
  "audio-mixer",
  "audio-channel",
  "sound-attenuation",
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

export function assetTypeForDocumentKind(kind: AssetDocumentKind): string {
  switch (kind) {
    case "scene":
      return "Scene";
    case "graph":
      return "Class";
    case "ui":
      return "UserInterface";
    case "font":
      return "Font";
    case "sprite":
      return "Sprite";
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
    case "audio-mixer":
      return "AudioMixer";
    case "audio-channel":
      return "AudioChannel";
    case "sound-attenuation":
      return "SoundAttenuation";
    case "asset-settings":
      return "Texture";
  }
}

/**
 * Preserve EditorUtilityInterface when a ui document is saved.
 *
 * A legacy `Shader` asset opens as a Material document and is rewritten to the
 * canonical `Material` header type on save, which the migrate-on-save approval
 * flow gates. Its `.shader.babasset` path is deliberately left alone so open
 * documents, layout ids, references and source-control locks stay valid.
 */
export function assetTypeForDocumentSave(
  kind: AssetDocumentKind,
  existingType?: string | null,
): string {
  if (kind === "ui" && existingType === "EditorUtilityInterface") {
    return "EditorUtilityInterface";
  }
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
    case "Graph":
    case "Class":
      return "graph";
    case "UserInterface":
    case "EditorUtilityInterface":
      return "ui";
    case "Font":
      return "font";
    case "Sprite":
      return "sprite";
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
    case "AudioMixer":
      return "audio-mixer";
    case "AudioChannel":
      return "audio-channel";
    case "SoundAttenuation":
      return "sound-attenuation";
    case "Texture":
    case "Model":
    case "Audio":
    case "Animation":
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
    case "graph":
      return "Class";
    case "ui":
      return "UI";
    case "font":
      return "Font";
    case "sprite":
      return "Sprite";
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
    case "audio-mixer":
      return "Audio Mixer";
    case "audio-channel":
      return "Audio Channel";
    case "sound-attenuation":
      return "Sound Attenuation";
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
        /\.(scene|graph|eui|ui|sprite|anim|shader|material|matfunc|class|tileset|tilemap|plugin|mixer|channel|atten)\.(babasset|json)$/i,
        "",
      )
      .replace(/\.babasset$/i, "") ?? path;
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
  const baseLabel =
    typeof named === "string" && named.trim() !== ""
      ? named
      : labelFromPath(path);
  return { kind, path, label: `${baseLabel} ${documentKindLabel(kind)}` };
}
