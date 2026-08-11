import type { SerializedGraph, SerializedScene } from "./project";

export type DocumentKind = "content-browser" | "scene" | "graph";

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

export function documentId(ref: Pick<DocumentRef, "kind" | "path">): string {
  if (ref.kind === "content-browser") {
    return CONTENT_BROWSER_ID;
  }
  return `${ref.kind}:${ref.path}`;
}

export function isContentBrowserId(id: string): boolean {
  return id === CONTENT_BROWSER_ID;
}

export function isClosableDocumentKind(kind: DocumentKind): boolean {
  return kind !== "content-browser";
}

export interface ProjectLayouts {
  documents: Record<string, Record<string, unknown>>;
  tabOrder: string[];
  activeDocumentId?: string | null;
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
      ?.replace(/\.(scene|graph)\.(babasset|json)$/, "") ?? path;
  return base
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createDocumentRef(
  kind: Exclude<DocumentKind, "content-browser">,
  path: string,
  content?: SerializedScene | SerializedGraph,
): DocumentRef {
  const baseLabel =
    kind === "scene" && content && "name" in content
      ? content.name
      : labelFromPath(path);
  const label = kind === "scene" ? `${baseLabel} Scene` : `${baseLabel} Graph`;
  return { kind, path, label };
}
