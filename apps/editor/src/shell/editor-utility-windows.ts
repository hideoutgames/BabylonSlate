import { normalizeEditorUtilityDockKind } from "@babylonslate/core";
import {
  findDockWindow,
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

const DOCK_KIND_FOR_DOCUMENT: Record<string, string> = {
  scene: "scene",
  graph: "class",
};

const DEFAULT_REFERENCE: Record<string, string> = {
  scene: "viewport",
  graph: "graph",
};

export function editorUtilityHostDocumentKind(
  dockKind: unknown,
): "scene" | "graph" {
  return normalizeEditorUtilityDockKind(dockKind) === "class" ? "graph" : "scene";
}

function editorUtilityWindowDefinition(
  asset: EditorUtilityAssetRef,
  hostKind: "scene" | "graph",
): DockWindowDefinition {
  const referencePanelId = DEFAULT_REFERENCE[hostKind];
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
  const dockKind = options?.kind
    ? DOCK_KIND_FOR_DOCUMENT[options.kind]
    : undefined;
  if (!dockKind || !options?.assets) return [];
  return options.assets
    .filter((asset) => asset.type === "EditorUtilityInterface")
    .filter(
      (asset) =>
        normalizeEditorUtilityDockKind(asset.payload?.dockKind) === dockKind,
    )
    .map((asset) =>
      editorUtilityWindowDefinition(
        asset,
        options.kind === "graph" ? "graph" : "scene",
      ),
    );
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

export function resolveEditorUtilityLiveHost(options: {
  dockKind: unknown;
  scenes: readonly string[];
  graphs: readonly string[];
}): { kind: "scene" | "graph"; path: string } | null {
  const kind = editorUtilityHostDocumentKind(options.dockKind);
  const path = (kind === "scene" ? options.scenes : options.graphs)[0];
  if (!path) return null;
  return { kind, path };
}

export function editorUtilityLiveTarget(options: {
  guid: string;
  assets: EditorUtilityAssetRef[];
  scenes: readonly string[];
  graphs: readonly string[];
}): {
  host: { kind: "scene" | "graph"; path: string };
  panelId: string;
} | null {
  const asset = options.assets.find(
    (entry) =>
      entry.guid === options.guid && entry.type === "EditorUtilityInterface",
  );
  if (!asset) return null;
  const host = resolveEditorUtilityLiveHost({
    dockKind: asset.payload?.dockKind,
    scenes: options.scenes,
    graphs: options.graphs,
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
