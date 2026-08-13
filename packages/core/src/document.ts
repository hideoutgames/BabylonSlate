import type { SerializedGraph } from "./project";
import type { SerializedScene } from "./scene";

export const ASSET_DOCUMENT_KINDS = [
  "scene",
  "graph",
  "ui",
  "font",
  "sprite",
  "anim-graph",
  "shader",
  "tileset",
  "tilemap",
  "enum",
  "structure",
  "script-interface",
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
    case "shader":
      return "Shader";
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
    case "asset-settings":
      return "Texture";
  }
}

export function documentKindForAssetType(type: string): AssetDocumentKind | null {
  switch (type) {
    case "Scene":
      return "scene";
    case "Graph":
    case "Class":
      return "graph";
    case "UserInterface":
      return "ui";
    case "Font":
      return "font";
    case "Sprite":
      return "sprite";
    case "AnimationGraph":
      return "anim-graph";
    case "Shader":
      return "shader";
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
    case "Texture":
    case "Material":
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
    case "shader":
      return "Shader";
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
}

export function createEmptyLayouts(): ProjectLayouts {
  return { documents: {}, tabOrder: [], activeDocumentId: null };
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
        /\.(scene|graph|ui|sprite|anim|shader|class|tileset|tilemap)\.(babasset|json)$/i,
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
