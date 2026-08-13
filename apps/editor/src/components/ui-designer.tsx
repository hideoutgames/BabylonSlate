import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssetPicker,
  NumberField,
  PanelFrame,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@babylonslate/ui/components/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  DESIRED_CANVAS_ID,
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
  type ScaleRule,
  type WidgetKind,
  type WidgetLayout,
} from "@babylonslate/ui-runtime";
import { GraphEditor } from "@babylonslate/graph-ui";
import type { SerializedGraph } from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import { familyFromAssetPayload } from "../lib/font-preview";
import { asUiDocument, type PlayUiLibrary } from "../lib/play-content";
import { collectFontAssetEntries } from "../lib/play-fonts";
import type { FontAssetEntry } from "@babylonslate/render";
import {
  resolveDesignerCanvasId,
  useEngineUiDesignerPresets,
} from "../lib/engine-ui-presets";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
} from "../services/graph-validation";
import { ClassMembersView } from "../panels/my-class-panel";
import { centeredFitView, previewScaleToFit, type DesignView } from "./ui-design-gestures";
import { UiWidgetCatalog } from "./ui-widget-catalog";
import { UiDesignCanvas } from "./ui-design-canvas";
import { UiDesignHierarchy } from "./ui-design-hierarchy";
import { UiDesignDetails } from "./ui-design-details";

const SCALE_RULES: Array<{ value: ScaleRule; label: string }> = [
  { value: "shortestSide", label: "Shortest Side" },
  { value: "fitWidth", label: "Fit Width" },
  { value: "fitHeight", label: "Fit Height" },
];

export function UiDesigner({
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const { openDocuments, assetRegistry, collectPlayUiLibrary, projectDocument, readAssetChunk } =
    useDocuments();
  const play = useOptionalPlay();
  const ui = asUiDocument(payload);
  const logic = (payload.logic ??
    createDefaultLogicGraphSerialized()) as SerializedGraph;
  const paletteNodes = useMemo(() => scriptPaletteNodes(), []);
  const [logicMemberId, setLogicMemberId] = useState<string | null>(null);
  const interfaceAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "ScriptInterface")
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
    }));
  const [presetId, setPresetId] = useState<DesignerCanvasId>("ipad-landscape");
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
  const [hierarchyOpen, setHierarchyOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [sharedEngine, setSharedEngine] = useState<
    import("@babylonjs/core").Engine | null
  >(null);
  const viewportMeasureRef = useRef<HTMLDivElement>(null);
  const latestPayloadRef = useRef(payload);
  latestPayloadRef.current = payload;

  const selfGuid =
    assetRegistry?.list().find((asset) => asset.path === path)?.header.guid ??
    path;
  useEffect(() => {
    let cancelled = false;
    const assets = (assetRegistry?.list() ?? []).map((asset) => ({
      guid: asset.header.guid,
      path: asset.path,
      type: asset.header.type,
      payload: asset.header.payload,
    }));
    void collectFontAssetEntries(assets, readAssetChunk ?? (async () => null)).then(
      (entries) => {
        if (!cancelled) setFontEntries(entries);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, readAssetChunk]);
  useEffect(() => {
    let cancelled = false;
    void collectPlayUiLibrary()
      .then((library) => {
        if (!cancelled) setUiLibrary(library);
      })
      .catch(() => {
        if (!cancelled) setUiLibrary({});
      });
    return () => {
      cancelled = true;
    };
  }, [collectPlayUiLibrary, openDocuments]);

  const resolveNested = (guid: string) => {
    if (guid === selfGuid) return ui;
    const asset = assetRegistry?.getByGuid(guid);
    if (asset) {
      const open = openDocuments.find((entry) => entry.ref.path === asset.path);
      if (open?.content) return asUiDocument(open.content);
    }
    return uiLibrary[guid] ?? null;
  };
  const viewport = designerViewport(presetId, ui.desiredSize, extras);
  const layout = layoutUserInterface(
    ui,
    { width: viewport.width, height: viewport.height },
    { safeArea: viewport.safeArea, resolveNested, designSpace: true },
  );
  const bitmapScale = designScale(
    { width: viewport.width, height: viewport.height },
    ui.designResolution,
    ui.scaleRule,
  );
  const controls = describeUiControls(ui, layout);
  const previewScale = previewScaleToFit(viewportSize, {
    width: viewport.width,
    height: viewport.height,
  });

  useEffect(() => {
    const el = viewportMeasureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSharedEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    if (viewportSize.width < 2 || viewportSize.height < 2) return;
    setView(
      centeredFitView(viewportSize, {
        width: viewport.width,
        height: viewport.height,
      }).view,
    );
  }, [presetId, viewport.width, viewport.height, viewportSize]);

  const selected = ui.widgets[selectedId] ?? ui.widgets[ui.rootId]!;
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

  function commit(next: Record<string, unknown>, mergeKey?: string) {
    latestPayloadRef.current = next;
    if (mergeKey !== undefined) onChange(next, mergeKey);
    else onChange(next);
  }

  function patchWidget(id: string, patch: Partial<(typeof ui.widgets)[string]>) {
    commit({
      ...payload,
      ...ui,
      widgets: { ...ui.widgets, [id]: { ...ui.widgets[id]!, ...patch } },
    });
  }

  function patchLayout(id: string, nextLayout: WidgetLayout, mergeKey?: string) {
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
  }

  const addWidget = (kind: WidgetKind) => {
    const id = `${kind.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
    const parent = ui.widgets[selectedId] ?? ui.widgets[ui.rootId]!;
    const widget = parentOwnsChildLayout(parent.kind)
      ? createWidget(id, kind, humanizePropertyLabel(kind))
      : createWidget(id, kind, humanizePropertyLabel(kind), defaultAddLayout(kind));
    const next = insertWidget(ui, widget, parent.id);
    commit({ ...payload, ...next });
    setSelectedId(widget.id);
  };

  return (
    <Tabs defaultValue="design" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <TabsList variant="line">
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="logic">Logic</TabsTrigger>
        </TabsList>
        <Button
          size="sm"
          variant="outline"
          data-testid="ui-add-widget"
          onClick={() => setCatalogOpen(true)}
        >
          Add Widget
        </Button>
        <Select
          value={presetId}
          onValueChange={(value) => setPresetId(value as DesignerCanvasId)}
        >
          <SelectTrigger className="w-48" data-testid="ui-device-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DESIRED_CANVAS_ID} data-testid="ui-preset-desired">
              Desired
            </SelectItem>
            {devicePresets.map((row) => (
              <SelectItem
                key={row.id}
                value={row.id}
                data-testid={`ui-preset-${row.id}`}
              >
                {row.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {presetId === DESIRED_CANVAS_ID ? (
          <>
            <Field orientation="horizontal" className="w-auto items-center">
              <FieldLabel className="text-xs">Width</FieldLabel>
              <NumberField
                data-testid="ui-desired-width"
                value={ui.desiredSize.width}
                min={1}
                onChange={(width) =>
                  commit({
                    ...payload,
                    ...ui,
                    desiredSize: { ...ui.desiredSize, width },
                  })
                }
              />
            </Field>
            <Field orientation="horizontal" className="w-auto items-center">
              <FieldLabel className="text-xs">Height</FieldLabel>
              <NumberField
                data-testid="ui-desired-height"
                value={ui.desiredSize.height}
                min={1}
                onChange={(height) =>
                  commit({
                    ...payload,
                    ...ui,
                    desiredSize: { ...ui.desiredSize, height },
                  })
                }
              />
            </Field>
          </>
        ) : null}
        <Select
          value={ui.scaleRule}
          onValueChange={(value) =>
            commit({ ...payload, ...ui, scaleRule: value as ScaleRule })
          }
        >
          <SelectTrigger className="w-40" data-testid="ui-scale-rule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCALE_RULES.map((row) => (
              <SelectItem key={row.value} value={row.value}>
                {row.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          data-testid="ui-design-fit"
          onClick={() =>
            setView(
              centeredFitView(viewportSize, {
                width: viewport.width,
                height: viewport.height,
              }).view,
            )
          }
        >
          Fit
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="ui-design-zoom">
          {Math.round(view.zoom * 100)}%
        </span>
        <Toggle
          size="sm"
          pressed={hierarchyOpen}
          onPressedChange={setHierarchyOpen}
          data-testid="ui-toggle-hierarchy"
          aria-label="Hierarchy"
        >
          Hierarchy
        </Toggle>
        <Toggle
          size="sm"
          pressed={detailsOpen}
          onPressedChange={setDetailsOpen}
          data-testid="ui-toggle-details"
          aria-label="Details"
        >
          Details
        </Toggle>
      </div>
      <TabsContent value="design" className="flex min-h-0 flex-1">
        {hierarchyOpen ? (
          <PanelFrame className="w-56 shrink-0 border-r border-border" title="Hierarchy">
            <UiDesignHierarchy
              ui={ui}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={(next) => commit({ ...payload, ...next })}
            />
          </PanelFrame>
        ) : null}
        <div ref={viewportMeasureRef} className="flex min-h-0 min-w-0 flex-1">
          <UiDesignCanvas
            ui={ui}
            viewport={viewport}
            layout={layout}
            controls={controls}
            selectedId={selectedId}
            view={view}
            previewScale={previewScale}
            bitmapScale={bitmapScale}
            sharedEngine={sharedEngine}
            fontEntries={fontEntries}
            onSelect={setSelectedId}
            onViewChange={setView}
            onLayoutChange={(id, nextLayout, mergeKey) =>
              patchLayout(id, nextLayout, mergeKey)
            }
          />
        </div>
        {detailsOpen ? (
          <PanelFrame className="w-72 shrink-0 border-l border-border" title="Details">
            <UiDesignDetails
              ui={ui}
              selected={selected}
              layout={layout}
              actionNames={normalizeInputMappings(
                projectDocument?.settings.input,
              ).actions.map((action) => action.name)}
              assetLabels={{
                nestedUi: (assetRegistry?.list() ?? []).find(
                  (asset) => asset.header.guid === selected.nestedUiGuid,
                )?.header.name,
                image: (assetRegistry?.list() ?? []).find(
                  (asset) =>
                    asset.header.guid ===
                    (typeof selected.props.imageGuid === "string"
                      ? selected.props.imageGuid
                      : selected.style.imageGuid),
                )?.header.name,
                font: selected.style.fontFamily,
                visualOverride: (assetRegistry?.list() ?? []).find(
                  (asset) => asset.header.guid === selected.visualOverrideGuid,
                )?.header.name,
              }}
              onPatchWidget={patchWidget}
              onPatchLayout={(id, nextLayout) => patchLayout(id, nextLayout)}
              onPickAsset={setAssetPick}
            />
          </PanelFrame>
        ) : null}
      </TabsContent>
      <TabsContent value="logic" className="flex min-h-0 flex-1">
        <PanelFrame className="w-56 shrink-0 border-r border-border">
          <div data-testid="ui-logic-members">
            <ClassMembersView
              graph={logic}
              selectedId={logicMemberId}
              interfaceAssets={interfaceAssets}
              onGraphChange={(next) =>
                onChange({
                  ...payload,
                  logic: next,
                })
              }
              onSelectMember={(id) => setLogicMemberId(id || null)}
            />
          </div>
        </PanelFrame>
        <GraphEditor
          initialGraph={hydrateSerializedGraphForEditor(logic)}
          paletteNodes={paletteNodes}
          onChange={(graph) =>
            commit({
              ...payload,
              logic: {
                ...graph,
                members: graph.members ?? logic.members,
              },
            })
          }
        />
      </TabsContent>
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
    </Tabs>
  );
}
