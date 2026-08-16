import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AssetPicker,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import {
  DEFAULT_DEVICE_PRESET_ID,
  contentDesiredSize,
  createWidget,
  defaultAddLayout,
  describeUiControls,
  designScale,
  designerViewport,
  insertWidget,
  layoutUserInterface,
  mergeDevicePresets,
  nestedUiPickableGuids,
  parentOwnsChildLayout,
  type DesignerCanvasId,
  type LayoutResult,
  type UiControlDescriptor,
  type UserInterfaceDocument,
  type WidgetKind,
  type WidgetLayout,
} from "@babylonslate/ui-runtime";
import { normalizeEditorUtilityDockKind } from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import { useDocuments } from "./document-context";
import {
  useOptionalDocumentWorkspace,
} from "./document-workspace-context";
import { useOptionalPlay } from "./play-context";
import { familyFromAssetPayload } from "../lib/font-preview";
import { asUiDocument, type PlayUiLibrary } from "../lib/play-content";
import { collectFontAssetEntries } from "../lib/play-fonts";
import type { FontAssetEntry } from "@babylonslate/render";
import {
  projectUiAssetCacheKey,
  rememberProjectUiAssets,
} from "../lib/project-ui-asset-cache";
import {
  resolveDesignerCanvasId,
  useEngineUiDesignerPresets,
} from "../lib/engine-ui-presets";
import {
  centeredFitView,
  previewScaleToFit,
  type DesignView,
} from "../components/ui-design-gestures";
import { UiWidgetCatalog } from "../components/ui-widget-catalog";

export interface UiEditingContextValue {
  path: string;
  payload: Record<string, unknown>;
  ui: UserInterfaceDocument;
  isEditorUtilityInterface: boolean;
  dockKind: ReturnType<typeof normalizeEditorUtilityDockKind>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  selected: UserInterfaceDocument["widgets"][string];
  presetId: DesignerCanvasId;
  setPresetId: (id: DesignerCanvasId) => void;
  devicePresets: ReturnType<typeof mergeDevicePresets>;
  view: DesignView;
  setView: (view: DesignView) => void;
  viewportSize: { width: number; height: number };
  setViewportSize: (size: { width: number; height: number }) => void;
  viewport: ReturnType<typeof designerViewport>;
  layout: LayoutResult;
  controls: readonly UiControlDescriptor[];
  previewScale: number;
  bitmapScale: number;
  sharedEngine: import("@babylonjs/core").Engine | null;
  fontEntries: FontAssetEntry[];
  catalogOpen: boolean;
  setCatalogOpen: (open: boolean) => void;
  actionNames: string[];
  assetLabels: {
    nestedUi?: string;
    image?: string;
    font?: string;
    visualOverride?: string;
  };
  commit: (next: Record<string, unknown>, mergeKey?: string) => void;
  patchWidget: (
    id: string,
    patch: Partial<UserInterfaceDocument["widgets"][string]>,
  ) => void;
  patchLayout: (id: string, nextLayout: WidgetLayout, mergeKey?: string) => void;
  addWidget: (kind: WidgetKind) => void;
  setAssetPick: (
    kind: "nestedUi" | "image" | "font" | "visualOverride" | null,
  ) => void;
  fitView: () => void;
}

const UiEditingContext = createContext<UiEditingContextValue | null>(null);

export function UiEditingProvider({
  children,
  path: pathProp,
  payload: payloadProp,
  onChange: onChangeProp,
}: {
  children: ReactNode;
  path?: string;
  payload?: Record<string, unknown>;
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const workspace = useOptionalDocumentWorkspace();
  const {
    openDocuments,
    assetRegistry,
    collectPlayUiLibrary,
    projectDocument,
    projectName,
    readAssetChunk,
    applyAssetDocumentChange,
  } = useDocuments();
  const play = useOptionalPlay();
  const doc = workspace
    ? openDocuments.find((entry) => entry.id === workspace.documentId)
    : undefined;
  const path = pathProp ?? doc?.ref.path ?? "";
  const payload = payloadProp ?? ((doc?.content ?? {}) as Record<string, unknown>);
  const onChange =
    onChangeProp ??
    ((next: Record<string, unknown>, mergeKey?: string) => {
      if (!workspace) return;
      void applyAssetDocumentChange(workspace.documentId, next, mergeKey);
    });

  const ui = useMemo(() => asUiDocument(payload), [payload]);
  const [presetId, setPresetId] = useState<DesignerCanvasId>(DEFAULT_DEVICE_PRESET_ID);
  const extras = useEngineUiDesignerPresets();
  const devicePresets = mergeDevicePresets(extras);
  useEffect(() => {
    const next = resolveDesignerCanvasId(presetId, extras);
    if (next !== presetId) setPresetId(next);
  }, [presetId, extras]);
  const [selectedId, setSelectedId] = useState(ui.rootId);
  const [assetPick, setAssetPick] = useState<
    "nestedUi" | "image" | "font" | "visualOverride" | null
  >(null);
  const [uiLibrary, setUiLibrary] = useState<PlayUiLibrary>({});
  const [fontEntries, setFontEntries] = useState<FontAssetEntry[]>([]);
  const [view, setView] = useState<DesignView>({ zoom: 1, panX: 0, panY: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [sharedEngine, setSharedEngine] = useState<
    import("@babylonjs/core").Engine | null
  >(null);
  const latestPayloadRef = useRef(payload);
  latestPayloadRef.current = payload;

  const indexed = (assetRegistry?.list() ?? []).find((asset) => asset.path === path);
  const isEditorUtilityInterface = indexed?.header.type === "EditorUtilityInterface";
  const dockKind = normalizeEditorUtilityDockKind(payload.dockKind);
  const selfGuid = indexed?.header.guid ?? path;

  useEffect(() => {
    let cancelled = false;
    const assets = (assetRegistry?.list() ?? []).map((asset) => ({
      guid: asset.header.guid,
      path: asset.path,
      type: asset.header.type,
      payload: asset.header.payload,
    }));
    const cached = rememberProjectUiAssets(
      projectUiAssetCacheKey(projectName, assets),
      {
        loadLibrary: collectPlayUiLibrary,
        loadFonts: () =>
          collectFontAssetEntries(assets, readAssetChunk ?? (async () => null)),
      },
    );
    void cached.library
      .then((library) => {
        if (!cancelled) setUiLibrary(library);
      })
      .catch(() => {
        if (!cancelled) setUiLibrary({});
      });
    void cached.fonts.then((entries) => {
      if (!cancelled) setFontEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, collectPlayUiLibrary, projectName, readAssetChunk]);

  const resolveNested = useCallback(
    (guid: string) => {
      if (guid === selfGuid) return ui;
      const asset = assetRegistry?.getByGuid(guid);
      if (asset) {
        const open = openDocuments.find((entry) => entry.ref.path === asset.path);
        if (open?.content) return asUiDocument(open.content);
      }
      return uiLibrary[guid] ?? null;
    },
    [assetRegistry, openDocuments, selfGuid, ui, uiLibrary],
  );

  const viewport = useMemo(
    () =>
      designerViewport(
        presetId,
        contentDesiredSize(ui, { resolveNested }),
        extras,
      ),
    [extras, presetId, resolveNested, ui],
  );
  const layout = useMemo(
    () =>
      layoutUserInterface(
        ui,
        { width: viewport.width, height: viewport.height },
        { safeArea: viewport.safeArea, resolveNested, designSpace: true },
      ),
    [resolveNested, ui, viewport.height, viewport.safeArea.bottom, viewport.safeArea.left, viewport.safeArea.right, viewport.safeArea.top, viewport.width],
  );
  const bitmapScale = useMemo(
    () =>
      designScale(
        { width: viewport.width, height: viewport.height },
        ui.designResolution,
        ui.scaleRule,
      ),
    [ui.designResolution, ui.scaleRule, viewport.height, viewport.width],
  );
  const controls = useMemo(() => describeUiControls(ui, layout), [layout, ui]);
  const previewScale = useMemo(
    () =>
      previewScaleToFit(viewportSize, {
        width: viewport.width,
        height: viewport.height,
      }),
    [viewport.height, viewport.width, viewportSize],
  );

  useEffect(() => {
    setSharedEngine(play?.ensureSharedEngine() ?? null);
  }, [play, play?.sharedEngineGeneration]);

  useEffect(() => {
    if (viewportSize.width < 2 || viewportSize.height < 2) return;
    setView(
      centeredFitView(viewportSize, {
        width: viewport.width,
        height: viewport.height,
      }).view,
    );
  }, [presetId, viewport.width, viewport.height, viewportSize]);

  const selected =
    ui.widgets[selectedId] ?? ui.widgets[ui.rootId] ?? createWidget(ui.rootId, "Canvas");
  const candidateGuids = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "UserInterface")
    .map((asset) => asset.header.guid);
  const pickable = new Set(
    nestedUiPickableGuids(selfGuid, candidateGuids, ui, resolveNested),
  );
  const pickerAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => pickable.has(asset.header.guid))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));

  const commit = useCallback(
    (next: Record<string, unknown>, mergeKey?: string) => {
      latestPayloadRef.current = next;
      if (mergeKey !== undefined) onChange(next, mergeKey);
      else onChange(next);
    },
    [onChange],
  );

  const patchWidget = useCallback(
    (id: string, patch: Partial<UserInterfaceDocument["widgets"][string]>) => {
      const current = asUiDocument(latestPayloadRef.current);
      const widget = current.widgets[id];
      if (!widget) return;
      commit({
        ...latestPayloadRef.current,
        ...current,
        widgets: { ...current.widgets, [id]: { ...widget, ...patch } },
      });
    },
    [commit],
  );

  const patchLayout = useCallback(
    (id: string, nextLayout: WidgetLayout, mergeKey?: string) => {
      const widget = asUiDocument(latestPayloadRef.current).widgets[id];
      if (!widget) return;
      const current = asUiDocument(latestPayloadRef.current);
      commit(
        {
          ...latestPayloadRef.current,
          ...current,
          widgets: {
            ...current.widgets,
            [id]: { ...widget, layout: nextLayout },
          },
        },
        mergeKey,
      );
    },
    [commit],
  );

  const addWidget = useCallback(
    (kind: WidgetKind) => {
      const id = `${kind.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
      const current = asUiDocument(latestPayloadRef.current);
      const parent = current.widgets[selectedId] ?? current.widgets[current.rootId];
      if (!parent) return;
      const widget = parentOwnsChildLayout(parent.kind)
        ? createWidget(id, kind, humanizePropertyLabel(kind))
        : createWidget(id, kind, humanizePropertyLabel(kind), defaultAddLayout(kind));
      const next = insertWidget(current, widget, parent.id);
      commit({ ...latestPayloadRef.current, ...next });
      setSelectedId(widget.id);
    },
    [commit, selectedId],
  );

  const fitView = useCallback(() => {
    setView(
      centeredFitView(viewportSize, {
        width: viewport.width,
        height: viewport.height,
      }).view,
    );
  }, [viewport.height, viewport.width, viewportSize]);

  const actionNames = normalizeInputMappings(
    projectDocument?.settings.input,
  ).actions.map((action) => action.name);
  const assetLabels = {
    nestedUi: (assetRegistry?.list() ?? []).find(
      (asset) => asset.header.guid === selected?.nestedUiGuid,
    )?.header.name,
    image: (assetRegistry?.list() ?? []).find(
      (asset) =>
        asset.header.guid ===
        (typeof selected?.props.imageGuid === "string"
          ? selected.props.imageGuid
          : selected?.style.imageGuid),
    )?.header.name,
    font: selected?.style.fontFamily,
    visualOverride: (assetRegistry?.list() ?? []).find(
      (asset) => asset.header.guid === selected?.visualOverrideGuid,
    )?.header.name,
  };

  const value = useMemo<UiEditingContextValue>(
    () => ({
      path,
      payload,
      ui,
      isEditorUtilityInterface,
      dockKind,
      selectedId,
      setSelectedId,
      selected,
      presetId,
      setPresetId,
      devicePresets,
      view,
      setView,
      viewportSize,
      setViewportSize,
      viewport,
      layout,
      controls,
      previewScale,
      bitmapScale,
      sharedEngine,
      fontEntries,
      catalogOpen,
      setCatalogOpen,
      actionNames,
      assetLabels,
      commit,
      patchWidget,
      patchLayout,
      addWidget,
      setAssetPick,
      fitView,
    }),
    [
      actionNames,
      addWidget,
      assetLabels,
      bitmapScale,
      catalogOpen,
      commit,
      controls,
      devicePresets,
      dockKind,
      fitView,
      fontEntries,
      isEditorUtilityInterface,
      layout,
      patchLayout,
      patchWidget,
      payload,
      path,
      presetId,
      previewScale,
      selected,
      selectedId,
      sharedEngine,
      ui,
      view,
      viewport,
      viewportSize,
    ],
  );

  return (
    <UiEditingContext.Provider value={value}>
      {children}
      <UiWidgetCatalog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        onSelect={addWidget}
      />
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={
          assetPick === "image"
            ? (assetRegistry?.list() ?? [])
                .filter((asset) => asset.header.type === "Texture")
                .map((asset) => ({
                  guid: asset.header.guid,
                  name: asset.header.name,
                  type: asset.header.type,
                  path: asset.path,
                }))
            : assetPick === "font"
              ? (assetRegistry?.list() ?? [])
                  .filter((asset) => asset.header.type === "Font")
                  .map((asset) => ({
                    guid: asset.header.guid,
                    name: asset.header.name,
                    type: asset.header.type,
                    path: asset.path,
                  }))
              : pickerAssets
        }
        allowedTypes={
          assetPick === "image"
            ? ["Texture"]
            : assetPick === "font"
              ? ["Font"]
              : ["UserInterface"]
        }
        allowNone
        title={
          assetPick === "image"
            ? "Pick Image"
            : assetPick === "font"
              ? "Pick Font"
              : assetPick === "visualOverride"
                ? "Pick Visual Override"
                : "Pick User Interface"
        }
        data-testid="ui-nested-picker"
        onPick={(guid) => {
          if (!selected) {
            setAssetPick(null);
            return;
          }
          if (assetPick === "nestedUi") {
            patchWidget(selected.id, { nestedUiGuid: guid });
          } else if (assetPick === "visualOverride") {
            patchWidget(selected.id, { visualOverrideGuid: guid });
          } else if (assetPick === "image") {
            patchWidget(selected.id, {
              props: { ...selected.props, imageGuid: guid },
            });
          } else if (assetPick === "font") {
            const family = guid
              ? familyFromAssetPayload(
                  assetRegistry?.getByGuid(guid)?.header.payload,
                ) ?? assetRegistry?.getByGuid(guid)?.header.name
              : undefined;
            patchWidget(selected.id, {
              style: { ...selected.style, fontFamily: family },
            });
          }
          setAssetPick(null);
        }}
      />
    </UiEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useUiEditing(): UiEditingContextValue {
  const context = useContext(UiEditingContext);
  if (!context) {
    throw new Error("useUiEditing must be used within UiEditingProvider");
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
