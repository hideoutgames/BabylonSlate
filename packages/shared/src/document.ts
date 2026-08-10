export type DocumentKind = "scene" | "graph";

export interface DocumentRef {
  kind: DocumentKind;
  path: string;
  label: string;
}

export function documentId(ref: Pick<DocumentRef, "kind" | "path">): string {
  return `${ref.kind}:${ref.path}`;
}

export interface ProjectLayouts {
  documents: Record<string, Record<string, unknown>>;
  tabOrder: string[];
}

export function createEmptyLayouts(): ProjectLayouts {
  return { documents: {}, tabOrder: [] };
}

export function migrateLegacyLayout(
  legacy: Record<string, unknown>,
  mainSceneId: string,
): ProjectLayouts {
  return {
    documents: { [mainSceneId]: legacy },
    tabOrder: [mainSceneId],
  };
}

export function labelFromPath(path: string): string {
  const base =
    path
      .split("/")
      .pop()
      ?.replace(/\.(scene|graph)\.json$/, "") ?? path;
  return base
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
