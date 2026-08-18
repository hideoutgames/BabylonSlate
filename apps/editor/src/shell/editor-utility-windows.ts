import {
  documentKindForAssetType,
  normalizeEditorUtilityDockKind,
  type EditorUtilityDockKind,
} from "@babylonslate/core";
import {
  findDockWindow,
  isDockviewDocumentKind,
  primaryDockPanel,
  type DockWindowDefinition,
  type DockWindowOptions,
  type DockviewDocumentKind,
} from "./window-catalog";

export type EditorUtilityAssetRef = {
  guid: string;
  name: string;
  type: string;
  payload?: Record<string, unknown>;
};

export type ListEditorUtilityWindowsOptions = DockWindowOptions & {
  kind?: string;
  assets?: EditorUtilityAssetRef[];
};

function dockKindForDocument(kind: string | undefined): EditorUtilityDockKind | undefined {
  if (!kind) return undefined;
  const normalized = kind === "class" ? "graph" : kind;
  return isDockviewDocumentKind(normalized)
    ? normalizeEditorUtilityDockKind(normalized)
    : undefined;
}

function editorUtilityWindowDefinition(
  asset: EditorUtilityAssetRef,
  hostKind: EditorUtilityDockKind,
): DockWindowDefinition {
  const referencePanelId = isDockviewDocumentKind(hostKind)
    ? primaryDockPanel(hostKind)
    : undefined;
  return {
    id: editorUtilityWindowId(asset.guid),
    component: "editor-utility",
    title: asset.name,
    ...(referencePanelId
      ? {
          defaultPosition: {
            referencePanelId,
            direction: "right" as const,
            initialWidth: 320,
          },
        }
      : {}),
  };
}

export function editorUtilityWindowId(guid: string): string {
  return `eui-${guid}`;
}

export function editorUtilityGuidFromWindowId(windowId: string): string | null {
  return windowId.startsWith("eui-") ? windowId.slice("eui-".length) : null;
}

export function editorUtilityAssetsFromIndexed(
  assets: ReadonlyArray<{
    path?: string;
    header: {
      guid: string;
      name: string;
      type: string;
      payload?: Record<string, unknown>;
    };
  }>,
  openDocuments: ReadonlyArray<{
    ref: { path: string };
    content: unknown;
  }> = [],
): EditorUtilityAssetRef[] {
  const openByPath = new Map(
    openDocuments.map((doc) => [doc.ref.path, doc.content]),
  );
  return assets.map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    payload: mergeEditorUtilityListingPayload(
      asset.header.payload,
      asset.path ? openByPath.get(asset.path) : undefined,
    ),
  }));
}

export function mergeEditorUtilityListingPayload(
  headerPayload: Record<string, unknown> | undefined,
  openContent: unknown,
): Record<string, unknown> | undefined {
  if (openContent && typeof openContent === "object" && !Array.isArray(openContent)) {
    return openContent as Record<string, unknown>;
  }
  return headerPayload;
}

/** EditorUtilityInterface widgets opened from Windows → Editor Utilities. */
export function listEditorUtilityWindows(
  options?: ListEditorUtilityWindowsOptions,
): DockWindowDefinition[] {
  const dockKind = dockKindForDocument(options?.kind);
  if (!dockKind || !options?.assets) return [];
  return options.assets
    .filter((asset) => asset.type === "EditorUtilityInterface")
    .filter(
      (asset) =>
        normalizeEditorUtilityDockKind(asset.payload?.dockKind) === dockKind,
    )
    .map((asset) => editorUtilityWindowDefinition(asset, dockKind));
}

/** Windows → Editor Utilities entries, including every EUI while authoring UI. */
export function listEditorUtilityMenuWindows(
  options?: ListEditorUtilityWindowsOptions,
): DockWindowDefinition[] {
  if (options?.kind === "ui") {
    if (!options.assets) return [];
    return options.assets
      .filter((asset) => asset.type === "EditorUtilityInterface")
      .map((asset) =>
        editorUtilityWindowDefinition(
          asset,
          editorUtilityHostDocumentKind(asset.payload?.dockKind),
        ),
      );
  }
  return listEditorUtilityWindows(options);
}

export function editorUtilityEmptyLabel(
  kind: string | undefined,
  assets: EditorUtilityAssetRef[],
): string | null {
  const hasEui = assets.some((asset) => asset.type === "EditorUtilityInterface");
  if (!hasEui) return "No Editor Utility Interfaces In This Project";
  if (listEditorUtilityMenuWindows({ kind, assets }).length === 0) {
    return "None For This Document";
  }
  return null;
}

export function editorUtilityHostDocumentKind(
  dockKind: unknown,
): EditorUtilityDockKind {
  return normalizeEditorUtilityDockKind(dockKind);
}

export function editorUtilityProjectPathsByKind(
  assets: ReadonlyArray<{ path: string; header: { type: string } }>,
): Partial<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  for (const asset of assets) {
    const kind = documentKindForAssetType(asset.header.type);
    if (!kind || !isDockviewDocumentKind(kind)) continue;
    (map[kind] ??= []).push(asset.path);
  }
  return map;
}

export function resolveEditorUtilityLiveHost(options: {
  dockKind: unknown;
  openDocuments: ReadonlyArray<{ kind: string; path: string }>;
  projectPathsByKind: Partial<Record<string, readonly string[]>>;
}): { kind: EditorUtilityDockKind; path: string } | null {
  const kind = normalizeEditorUtilityDockKind(options.dockKind);
  const openPath = options.openDocuments.find((doc) => doc.kind === kind)?.path;
  if (openPath) return { kind, path: openPath };
  const projectPath = options.projectPathsByKind[kind]?.[0];
  if (!projectPath) return null;
  return { kind, path: projectPath };
}

export function editorUtilityLiveTarget(options: {
  guid: string;
  assets: EditorUtilityAssetRef[];
  openDocuments: ReadonlyArray<{ kind: string; path: string }>;
  projectPathsByKind: Partial<Record<string, readonly string[]>>;
}): {
  host: { kind: EditorUtilityDockKind; path: string };
  panelId: string;
} | null {
  const asset = options.assets.find(
    (entry) =>
      entry.guid === options.guid && entry.type === "EditorUtilityInterface",
  );
  if (!asset) return null;
  const host = resolveEditorUtilityLiveHost({
    dockKind: asset.payload?.dockKind,
    openDocuments: options.openDocuments,
    projectPathsByKind: options.projectPathsByKind,
  });
  if (!host) return null;
  return { host, panelId: editorUtilityWindowId(asset.guid) };
}

export function findDockOrUtilityWindow(
  kind: DockviewDocumentKind,
  panelId: string,
  options?: ListEditorUtilityWindowsOptions,
): DockWindowDefinition | undefined {
  return (
    findDockWindow(kind, panelId, options) ??
    listEditorUtilityWindows({ ...options, kind }).find(
      (entry) => entry.id === panelId,
    )
  );
}

export function closeMismatchedEditorUtilityPanels(
  api: {
    getPanel: (id: string) => { api: { close: () => void } } | undefined;
    panels?: ReadonlyArray<{ id: string }> | Iterable<{ id: string }>;
  },
  kind: string,
  assets: EditorUtilityAssetRef[],
): void {
  const allowed = new Set(
    listEditorUtilityWindows({ kind, assets }).map((entry) => entry.id),
  );
  const panels = api.panels
    ? Array.isArray(api.panels)
      ? api.panels
      : [...api.panels]
    : [];
  for (const panel of panels) {
    if (!panel.id.startsWith("eui-")) continue;
    if (!allowed.has(panel.id)) {
      api.getPanel(panel.id)?.api.close();
    }
  }
}
