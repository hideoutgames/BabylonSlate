import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import {
  AssetPicker,
  NamePromptDialog,
  PanelFrame,
  PropertyGrid,
  NumberField,
  TreeView,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import type { PropertyRow, TreeViewNode } from "@babylonslate/editor-kit";
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
import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import {
  DESIRED_CANVAS_ID,
  WIDGET_KINDS,
  ZERO_INSETS,
  clamp01,
  createWidget,
  describeUiControls,
  designerViewport,
  layoutUserInterface,
  mergeDevicePresets,
  nestedUiPickableGuids,
  type DesignerCanvasId,
  type WidgetKind,
  type WidgetLayout,
} from "@babylonslate/ui-runtime";
import { GraphEditor } from "@babylonslate/graph-ui";
import type { GraphClassMemberKind, SerializedGraph } from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import { useDocuments } from "../context/document-context";
import { familyFromAssetPayload } from "../lib/font-preview";
import { asUiDocument, type PlayUiLibrary } from "../lib/play-content";
import {
  resolveDesignerCanvasId,
  useEngineUiDesignerPresets,
} from "../lib/engine-ui-presets";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
  scriptPaletteNodes,
} from "../services/graph-validation";
import { addClassMember, memberNamePromptCopy } from "../lib/class-members";
import {
  BLUEPRINT_SECTIONS,
  blueprintTreeNodes,
  membersForGraph,
} from "../panels/my-class-panel";
import {
  applyWidgetDragOffset,
  canvasDeltaToLayoutDelta,
  clampDesignZoom,
  pointerCentroid,
  pointerSpan,
  uiDesignStrokeMergeKey,
  zoomAtPoint,
  type DesignView,
  type PointerPoint,
} from "./ui-design-gestures";

export function UiDesigner({
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const { openDocuments, assetRegistry, collectPlayUiLibrary, projectDocument } =
    useDocuments();
  const ui = asUiDocument(payload);
  const logic = (payload.logic ??
    createDefaultLogicGraphSerialized()) as SerializedGraph;
  const paletteNodes = useMemo(() => scriptPaletteNodes(), []);
  const [memberCollapsed, setMemberCollapsed] = useState<Set<string>>(
    () => new Set(),
  );
  const [memberPromptKind, setMemberPromptKind] =
    useState<GraphClassMemberKind | null>(null);
  const logicMembers = useMemo(() => membersForGraph(logic), [logic]);
  const memberTree = useMemo(() => {
    return blueprintTreeNodes(logicMembers, memberCollapsed).map((row) => {
      if (!row.id.startsWith("section-")) return row;
      const sectionId = row.id.replace(/^section-/, "");
      const section = BLUEPRINT_SECTIONS.find((entry) => entry.id === sectionId);
      if (!section) return row;
      return {
        ...row,
        trailing: (
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Add ${section.label.slice(0, -1).toLowerCase()}`}
            data-testid={`class-add-${section.id}`}
            onPointerDown={stopRowGesture}
            onClick={(event) => {
              stopRowGesture(event);
              setMemberPromptKind(section.kind);
            }}
          >
            +
          </button>
        ),
      };
    });
  }, [logicMembers, memberCollapsed]);
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
  const [view, setView] = useState<DesignView>({ zoom: 1, panX: 0, panY: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const latestPayloadRef = useRef(payload);
  const viewRef = useRef(view);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const panStartRef = useRef({
    panX: 0,
    panY: 0,
    zoom: 1,
    cx: 0,
    cy: 0,
    span: 0,
  });
  const dragRef = useRef<{
    id: string;
    lastX: number;
    lastY: number;
    strokeId: string;
  } | null>(null);
  viewRef.current = view;
  useEffect(() => {
    latestPayloadRef.current = payload;
  }, [payload]);
  const selfGuid =
    assetRegistry?.list().find((asset) => asset.path === path)?.header.guid ??
    path;
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
    { safeArea: viewport.safeArea, resolveNested },
  );
  const controls = describeUiControls(ui, layout, viewport.height);
  const treeNodes: TreeViewNode[] = [];
  const walk = (id: string, depth: number) => {
    const widget = ui.widgets[id];
    if (!widget) return;
    treeNodes.push({
      id,
      label: widget.name,
      depth,
      hasChildren: widget.children.length > 0,
      expanded: true,
    });
    for (const child of widget.children) walk(child, depth + 1);
  };
  walk(ui.rootId, 0);
  const selected = ui.widgets[selectedId] ?? ui.widgets[ui.rootId];
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

  const previewScale =
    viewport.id === DESIRED_CANVAS_ID
      ? Math.min(1, 640 / viewport.width)
      : 0.45;
  const viewScale = previewScale * view.zoom;

  function patchWidget(
    id: string,
    patch: Partial<(typeof ui.widgets)[string]>,
  ) {
    onChange({
      ...payload,
      ...ui,
      widgets: { ...ui.widgets, [id]: { ...ui.widgets[id]!, ...patch } },
    });
  }

  function patchLayout(id: string, layoutPatch: Partial<WidgetLayout>) {
    const widget = ui.widgets[id];
    if (!widget) return;
    patchWidget(id, { layout: { ...widget.layout, ...layoutPatch } });
  }

  const padding = selected?.style.padding ?? ZERO_INSETS;
  const rows: PropertyRow[] = selected
    ? [
        {
          id: "name",
          kind: "text",
          label: "Name",
          value: selected.name,
          onChange: (value) => patchWidget(selected.id, { name: value }),
        },
        {
          id: "visible",
          kind: "boolean",
          label: "Visible",
          value: selected.visible,
          onChange: (value) => patchWidget(selected.id, { visible: value }),
        },
        ...(selected.kind === "UserInterface"
          ? [
              {
                id: "nestedUi",
                kind: "asset" as const,
                label: "User Interface",
                value: selected.nestedUiGuid ?? null,
                placeholder: "None",
                onPick: () => setAssetPick("nestedUi"),
                onChange: (value: string | null) =>
                  patchWidget(selected.id, { nestedUiGuid: value }),
              },
            ]
          : selected.kind === "Text" ||
              selected.kind === "Button" ||
              selected.kind === "TextInput"
            ? [
                {
                  id: "text",
                  kind: "text" as const,
                  label: "Text",
                  value:
                    typeof selected.props.text === "string"
                      ? selected.props.text
                      : "",
                  onChange: (value: string) =>
                    patchWidget(selected.id, {
                      props: { ...selected.props, text: value },
                    }),
                },
              ]
            : []),
        ...(selected.kind === "Image"
          ? [
              {
                id: "image",
                kind: "asset" as const,
                label: "Image",
                value:
                  typeof selected.props.imageGuid === "string"
                    ? selected.props.imageGuid
                    : (selected.style.imageGuid ?? null),
                placeholder: "None",
                displayLabel: (assetRegistry?.list() ?? []).find(
                  (asset) =>
                    asset.header.guid ===
                    (typeof selected.props.imageGuid === "string"
                      ? selected.props.imageGuid
                      : selected.style.imageGuid),
                )?.header.name,
                onPick: () => setAssetPick("image"),
                onChange: (value: string | null) =>
                  patchWidget(selected.id, {
                    props: { ...selected.props, imageGuid: value },
                  }),
              },
            ]
          : []),
        ...(selected.kind === "Text" ||
        selected.kind === "Button" ||
        selected.kind === "TextInput"
          ? [
              {
                id: "font",
                kind: "asset" as const,
                label: "Font",
                value:
                  (assetRegistry?.list() ?? []).find(
                    (asset) =>
                      asset.header.type === "Font" &&
                      familyFromAssetPayload(asset.header.payload) ===
                        selected.style.fontFamily,
                  )?.header.guid ?? null,
                placeholder: "None",
                displayLabel: selected.style.fontFamily,
                onPick: () => setAssetPick("font"),
                onChange: (value: string | null) => {
                  const family = value
                    ? familyFromAssetPayload(
                        assetRegistry?.getByGuid(value)?.header.payload,
                      ) ?? assetRegistry?.getByGuid(value)?.header.name
                    : undefined;
                  patchWidget(selected.id, {
                    style: { ...selected.style, fontFamily: family },
                  });
                },
              },
            ]
          : []),
        ...(selected.kind === "Button" ||
        selected.kind === "TouchJoystick" ||
        selected.kind === "TouchButton"
          ? [
              {
                id: "visual-override",
                kind: "asset" as const,
                label: "Visual Override",
                value: selected.visualOverrideGuid ?? null,
                placeholder: "None",
                displayLabel: (assetRegistry?.list() ?? []).find(
                  (asset) => asset.header.guid === selected.visualOverrideGuid,
                )?.header.name,
                onPick: () => setAssetPick("visualOverride"),
                onChange: (value: string | null) =>
                  patchWidget(selected.id, { visualOverrideGuid: value }),
              },
            ]
          : []),
        ...(selected.kind === "TouchButton"
          ? [
              {
                id: "action",
                kind: "enum" as const,
                label: "Action",
                value: String(selected.props.action ?? ""),
                options: normalizeInputMappings(
                  projectDocument?.settings.input,
                ).actions.map((action) => ({
                  value: action.name,
                  label: action.name,
                })),
                onChange: (value: string) =>
                  patchWidget(selected.id, {
                    props: { ...selected.props, action: value },
                  }),
              },
            ]
          : []),
        {
          id: "anchor-min",
          kind: "vector3",
          label: "Anchor Min",
          value: [selected.layout.anchorMin.x, selected.layout.anchorMin.y, 0],
          axes: ["X", "Y"],
          onChange: ([x, y]) =>
            patchLayout(selected.id, {
              anchorMin: { x: clamp01(x), y: clamp01(y) },
            }),
        },
        {
          id: "anchor-max",
          kind: "vector3",
          label: "Anchor Max",
          value: [selected.layout.anchorMax.x, selected.layout.anchorMax.y, 0],
          axes: ["X", "Y"],
          onChange: ([x, y]) =>
            patchLayout(selected.id, {
              anchorMax: { x: clamp01(x), y: clamp01(y) },
            }),
        },
        {
          id: "offset-min",
          kind: "vector3",
          label: "Offset Min",
          value: [selected.layout.offsetMin.x, selected.layout.offsetMin.y, 0],
          axes: ["X", "Y"],
          onChange: ([x, y]) =>
            patchLayout(selected.id, { offsetMin: { x, y } }),
        },
        {
          id: "offset-max",
          kind: "vector3",
          label: "Offset Max",
          value: [selected.layout.offsetMax.x, selected.layout.offsetMax.y, 0],
          axes: ["X", "Y"],
          onChange: ([x, y]) =>
            patchLayout(selected.id, { offsetMax: { x, y } }),
        },
        {
          id: "pivot",
          kind: "vector3",
          label: "Pivot",
          value: [selected.layout.pivot.x, selected.layout.pivot.y, 0],
          axes: ["X", "Y"],
          onChange: ([x, y]) =>
            patchLayout(selected.id, { pivot: { x: clamp01(x), y: clamp01(y) } }),
        },
        {
          id: "padding-left",
          kind: "number",
          label: "Padding Left",
          value: padding.left,
          onChange: (left) =>
            patchWidget(selected.id, {
              style: { ...selected.style, padding: { ...padding, left } },
            }),
        },
        {
          id: "padding-right",
          kind: "number",
          label: "Padding Right",
          value: padding.right,
          onChange: (right) =>
            patchWidget(selected.id, {
              style: { ...selected.style, padding: { ...padding, right } },
            }),
        },
        {
          id: "padding-top",
          kind: "number",
          label: "Padding Top",
          value: padding.top,
          onChange: (top) =>
            patchWidget(selected.id, {
              style: { ...selected.style, padding: { ...padding, top } },
            }),
        },
        {
          id: "padding-bottom",
          kind: "number",
          label: "Padding Bottom",
          value: padding.bottom,
          onChange: (bottom) =>
            patchWidget(selected.id, {
              style: { ...selected.style, padding: { ...padding, bottom } },
            }),
        },
      ]
    : [];

  const addWidget = (kind: WidgetKind) => {
    const id = `${kind.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
    const widget = createWidget(id, kind);
    const parent = ui.widgets[selectedId] ?? ui.widgets[ui.rootId]!;
    onChange({
      ...payload,
      ...ui,
      widgets: {
        ...ui.widgets,
        [widget.id]: widget,
        [parent.id]: { ...parent, children: [...parent.children, widget.id] },
      },
    });
    setSelectedId(widget.id);
  };

  const capturePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (typeof event.currentTarget.setPointerCapture !== "function") return;
    try {
      event.currentTarget.setPointerCapture(eventPointerId(event));
    } catch {
      /* jsdom */
    }
  };

  const beginTwoFinger = () => {
    dragRef.current = null;
    const centroid = pointerCentroid(pointersRef.current);
    panStartRef.current = {
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      zoom: viewRef.current.zoom,
      cx: centroid.x,
      cy: centroid.y,
      span: pointerSpan(pointersRef.current),
    };
  };

  const onViewportPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    capturePointer(event);
    const pointerId = eventPointerId(event);
    pointersRef.current.set(pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2) {
      beginTwoFinger();
      return;
    }
    const host = (event.target as Element | null)?.closest(
      "[data-widget-id]",
    );
    const widgetId = host?.getAttribute("data-widget-id");
    if (!widgetId) return;
    if (ui.widgets[widgetId]) {
      setSelectedId(widgetId);
      if (widgetId !== ui.rootId) {
        dragRef.current = {
          id: widgetId,
          lastX: event.clientX,
          lastY: event.clientY,
          strokeId: newStrokeId(),
        };
      }
      return;
    }
    setSelectedId(widgetId.split("/")[0] ?? ui.rootId);
  };

  const onViewportPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointerId = eventPointerId(event);
    const tracked = pointersRef.current.get(pointerId);
    if (!tracked) return;
    pointersRef.current.set(pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2) {
      const centroid = pointerCentroid(pointersRef.current);
      const span = pointerSpan(pointersRef.current);
      const start = panStartRef.current;
      setView({
        zoom: clampDesignZoom(
          start.span > 0 ? start.zoom * (span / start.span) : start.zoom,
        ),
        panX: start.panX + (centroid.x - start.cx),
        panY: start.panY + (centroid.y - start.cy),
      });
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const screenDelta = {
      x: event.clientX - drag.lastX,
      y: event.clientY - drag.lastY,
    };
    if (screenDelta.x === 0 && screenDelta.y === 0) return;
    const current = asUiDocument(latestPayloadRef.current);
    const widget = current.widgets[drag.id];
    if (!widget) return;
    const delta = canvasDeltaToLayoutDelta(screenDelta, viewScale);
    const nextLayout = applyWidgetDragOffset(widget.layout, delta);
    const next = {
      ...latestPayloadRef.current,
      ...current,
      widgets: {
        ...current.widgets,
        [drag.id]: { ...widget, layout: nextLayout },
      },
    };
    latestPayloadRef.current = next;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    onChange(next, uiDesignStrokeMergeKey(drag.strokeId));
  };

  const onViewportPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(eventPointerId(event));
    if (pointersRef.current.size < 2) {
      dragRef.current = null;
    }
    if (pointersRef.current.size >= 2) beginTwoFinger();
  };

  const onViewportWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((current) =>
      zoomAtPoint(current, current.zoom * factor, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      }),
    );
  };

  return (
    <Tabs defaultValue="design" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <TabsList variant="line">
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="logic">Logic</TabsTrigger>
        </TabsList>
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
        <Field className="w-28">
          <FieldLabel>Desired Width</FieldLabel>
          <NumberField
            data-testid="ui-desired-width"
            value={ui.desiredSize.width}
            min={1}
            onChange={(width) =>
              onChange({
                ...payload,
                ...ui,
                desiredSize: { ...ui.desiredSize, width },
              })
            }
          />
        </Field>
        <Field className="w-28">
          <FieldLabel>Desired Height</FieldLabel>
          <NumberField
            data-testid="ui-desired-height"
            value={ui.desiredSize.height}
            min={1}
            onChange={(height) =>
              onChange({
                ...payload,
                ...ui,
                desiredSize: { ...ui.desiredSize, height },
              })
            }
          />
        </Field>
      </div>
      <TabsContent value="design" className="flex min-h-0 flex-1">
        <PanelFrame className="w-56 shrink-0 border-r border-border">
          <div className="flex flex-wrap gap-1 p-2">
            {WIDGET_KINDS.filter((kind) => kind !== "Canvas").map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                data-testid={`ui-add-widget-${kind}`}
                onClick={() => addWidget(kind)}
              >
                {humanizePropertyLabel(kind)}
              </Button>
            ))}
          </div>
          <TreeView
            nodes={treeNodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            data-testid="ui-widget-tree"
          />
        </PanelFrame>
        <div
          ref={viewportRef}
          className="flex min-h-0 min-w-0 flex-1 touch-none items-center justify-center overflow-hidden bg-muted/30 p-4"
          data-testid="ui-design-viewport"
          onPointerDown={onViewportPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={onViewportPointerUp}
          onPointerCancel={onViewportPointerUp}
          onWheel={onViewportWheel}
        >
          <div
            className="relative bg-background shadow-sm"
            data-testid="ui-design-canvas"
            data-preset={viewport.id}
            data-scale={String(layout.scale)}
            data-zoom={String(view.zoom)}
            data-pan-x={String(view.panX)}
            data-pan-y={String(view.panY)}
            style={{
              width: viewport.width * previewScale,
              height: viewport.height * previewScale,
              transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {controls.map((control) => (
              <Button
                key={control.id}
                type="button"
                variant="outline"
                data-testid={`ui-widget-${control.id}`}
                data-widget-id={control.id}
                data-kind={control.kind}
                data-gui-x={String(Math.round(control.guiRect.x))}
                data-gui-y={String(Math.round(control.guiRect.y))}
                className="absolute h-auto min-h-0 rounded-sm border-border/80 bg-card/80 px-0 py-0 text-[10px] text-foreground"
                style={{
                  left: `${(control.guiRect.x / viewport.width) * 100}%`,
                  top: `${(control.guiRect.y / viewport.height) * 100}%`,
                  width: `${(control.guiRect.width / viewport.width) * 100}%`,
                  height: `${(control.guiRect.height / viewport.height) * 100}%`,
                }}
                onClick={() => {
                  if (ui.widgets[control.id]) {
                    setSelectedId(control.id);
                    return;
                  }
                  setSelectedId(control.id.split("/")[0] ?? ui.rootId);
                }}
              >
                {control.text ?? control.name}
              </Button>
            ))}
          </div>
        </div>
        <PanelFrame className="w-72 shrink-0 border-l border-border" title="Details">
          <PropertyGrid rows={rows} />
        </PanelFrame>
      </TabsContent>
      <TabsContent value="logic" className="flex min-h-0 flex-1">
        <PanelFrame className="w-56 shrink-0 border-r border-border">
          <div data-testid="ui-logic-members">
            <TreeView
              nodes={memberTree}
              onToggleExpanded={(id) => {
                const sectionId = id.replace(/^section-/, "");
                setMemberCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(sectionId)) next.delete(sectionId);
                  else next.add(sectionId);
                  return next;
                });
              }}
              emptyLabel="No class members"
              data-testid="my-blueprint-tree"
            />
          </div>
        </PanelFrame>
        <GraphEditor
          initialGraph={hydrateSerializedGraphForEditor(logic)}
          paletteNodes={paletteNodes}
          onChange={(graph) =>
            onChange({
              ...payload,
              logic: {
                ...graph,
                members: graph.members ?? logic.members,
              },
            })
          }
        />
      </TabsContent>
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
      <NamePromptDialog
        open={memberPromptKind !== null}
        onOpenChange={(open) => {
          if (!open) setMemberPromptKind(null);
        }}
        title={
          memberPromptKind
            ? memberNamePromptCopy(memberPromptKind).title
            : "Add Member"
        }
        label={
          memberPromptKind
            ? memberNamePromptCopy(memberPromptKind).label
            : "Name"
        }
        onSubmit={(name) => {
          if (!memberPromptKind) return;
          onChange({
            ...payload,
            logic: addClassMember(logic, memberPromptKind, name),
          });
        }}
      />
    </Tabs>
  );
}

function stopRowGesture(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function eventPointerId(event: PointerEvent<Element>): number {
  const native = event.nativeEvent as unknown as { pointerId?: number };
  if (typeof native.pointerId === "number") return native.pointerId;
  return event.pointerId;
}

function newStrokeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
