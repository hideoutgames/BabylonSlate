import { useState } from "react";
import { PanelFrame, PropertyGrid, SelectableText, TreeView } from "@babylonslate/editor-kit";
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
  DEVICE_PRESETS,
  WIDGET_KINDS,
  compileFontStack,
  createWidget,
  describeUiControls,
  glyphsFallingToFallback,
  layoutUserInterface,
  type DevicePreset,
  type UserInterfaceDocument,
  type WidgetKind,
} from "@babylonslate/ui-runtime";
import { normalizeFontPayload, type SpritePayload } from "@babylonslate/assets";
import {
  animGraphToSerialized,
  serializedToAnimGraph,
  validateAnimGraph,
  type AnimGraphDocument,
} from "@babylonslate/anim-graph";
import {
  SHADER_CATALOG,
  compileShaderGraph,
  createDefaultShaderGraph,
  shaderGraphToSerialized,
  serializedToShaderGraph,
  validateShaderGraph,
  type ShaderGraphDocument,
} from "@babylonslate/shader-graph";
import { GraphEditor, type PaletteNode } from "@babylonslate/graph-ui";
import type { SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
} from "../services/graph-validation";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asUiDocument(value: unknown): UserInterfaceDocument {
  const record = asRecord(value);
  return {
    name: typeof record.name === "string" ? record.name : "HUD",
    rootId: typeof record.rootId === "string" ? record.rootId : "canvas",
    designResolution:
      record.designResolution && typeof record.designResolution === "object"
        ? (record.designResolution as UserInterfaceDocument["designResolution"])
        : { width: 1920, height: 1080 },
    scaleRule:
      record.scaleRule === "fitWidth" || record.scaleRule === "fitHeight"
        ? record.scaleRule
        : "shortestSide",
    viewportLayer: record.viewportLayer !== false,
    widgets: asRecord(record.widgets) as UserInterfaceDocument["widgets"],
  };
}

export function AssetDocumentWorkspace({ documentId }: { documentId: string }) {
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  if (!doc) return null;
  const payload = asRecord(doc.content);
  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
  };
  if (doc.ref.kind === "ui") return <UiDesigner payload={payload} onChange={commit} />;
  if (doc.ref.kind === "font") return <FontEditor payload={payload} onChange={commit} />;
  if (doc.ref.kind === "sprite") return <SpriteEditor payload={payload} onChange={commit} />;
  if (doc.ref.kind === "anim-graph") {
    return <AnimGraphEditor payload={payload} onChange={commit} />;
  }
  if (doc.ref.kind === "shader") {
    return <ShaderGraphEditor payload={payload} onChange={commit} />;
  }
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Unsupported document
    </div>
  );
}

function UiDesigner({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const ui = asUiDocument(payload);
  const logic = (payload.logic ??
    createDefaultLogicGraphSerialized()) as SerializedGraph;
  const [presetId, setPresetId] = useState<DevicePreset["id"]>("ipad-landscape");
  const [selectedId, setSelectedId] = useState(ui.rootId);
  const preset =
    DEVICE_PRESETS.find((row) => row.id === presetId) ?? DEVICE_PRESETS[0]!;
  const layout = layoutUserInterface(
    ui,
    { width: preset.width, height: preset.height },
    { safeArea: preset.safeArea },
  );
  const controls = describeUiControls(ui, layout, preset.height);
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
        {
          id: "text",
          kind: "text",
          label: "Text",
          value: typeof selected.props.text === "string" ? selected.props.text : "",
          onChange: (value) =>
            patchWidget(selected.id, {
              props: { ...selected.props, text: value },
            }),
        },
      ]
    : [];

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

  return (
    <Tabs defaultValue="design" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <TabsList variant="line">
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="logic">Logic</TabsTrigger>
        </TabsList>
        <Select
          value={presetId}
          onValueChange={(value) =>
            setPresetId(value as DevicePreset["id"])
          }
        >
          <SelectTrigger className="w-48" data-testid="ui-device-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEVICE_PRESETS.map((row) => (
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
      </div>
      <TabsContent value="design" className="flex min-h-0 flex-1">
        <PanelFrame className="w-56 shrink-0 border-r border-border">
          <div className="flex flex-wrap gap-1 p-2">
            {WIDGET_KINDS.filter((kind) => kind !== "Canvas").map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                onClick={() => addWidget(kind)}
              >
                {kind}
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
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
          <div
            className="relative bg-background shadow-sm"
            data-testid="ui-design-canvas"
            data-preset={preset.id}
            data-scale={String(layout.scale)}
            style={{
              width: preset.width * 0.45,
              height: preset.height * 0.45,
            }}
          >
            {controls.map((control) => (
              <Button
                key={control.id}
                type="button"
                variant="outline"
                data-testid={`ui-widget-${control.id}`}
                data-kind={control.kind}
                className="absolute h-auto min-h-0 rounded-sm border-border/80 bg-card/80 px-0 py-0 text-[10px] text-foreground"
                style={{
                  left: `${(control.guiRect.x / preset.width) * 100}%`,
                  top: `${(control.guiRect.y / preset.height) * 100}%`,
                  width: `${(control.guiRect.width / preset.width) * 100}%`,
                  height: `${(control.guiRect.height / preset.height) * 100}%`,
                }}
                onClick={() => setSelectedId(control.id)}
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
        <GraphEditor
          initialGraph={hydrateSerializedGraphForEditor(logic)}
          onChange={(graph) => onChange({ ...payload, logic: graph })}
        />
      </TabsContent>
    </Tabs>
  );
}

function FontEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const font = normalizeFontPayload(payload, "Custom Font");
  const [sample, setSample] = useState("The quick brown fox");
  const flagged = glyphsFallingToFallback(
    sample,
    font.family,
    (text, stack) => {
      if (typeof document === "undefined") {
        return stack.includes(font.family) && /[A-Za-z]/.test(text) ? 10 : 7;
      }
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return 0;
      ctx.font = `16px ${stack}`;
      return ctx.measureText(text).width;
    },
  );
  return (
    <PanelFrame className="flex-1" title="Font">
      <div data-testid="font-editor">
        <PropertyGrid
          rows={[
            {
              id: "family",
              kind: "text",
              label: "Family",
              value: font.family,
              onChange: (value) => onChange({ ...font, family: value }),
            },
            {
              id: "sample",
              kind: "text",
              label: "Sample Text",
              value: sample,
              onChange: setSample,
            },
          ]}
        />
        <p
          className="px-3 text-sm"
          data-testid="font-sample-preview"
          style={{ fontFamily: compileFontStack({ family: font.family }) }}
        >
          <SelectableText>{sample}</SelectableText>
        </p>
        <p
          className="px-3 text-xs text-muted-foreground"
          data-testid="font-fallback-glyphs"
        >
          {flagged.length > 0
            ? `Fallback glyphs: ${flagged.join(" ")}`
            : "No fallback glyphs detected"}
        </p>
      </div>
    </PanelFrame>
  );
}

function SpriteEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const sprite = payload as unknown as SpritePayload;
  const frame = sprite.frames?.[0];
  return (
    <PanelFrame className="flex-1" title="Sprite">
      <div data-testid="sprite-editor">
        <PropertyGrid
          rows={[
            {
              id: "ppu",
              kind: "number",
              label: "Pixels Per Unit",
              value: sprite.pixelsPerUnit ?? 100,
              onChange: (value) => onChange({ ...sprite, pixelsPerUnit: value }),
            },
            {
              id: "pivot",
              kind: "vector3",
              label: "Pivot",
              value: [frame?.pivot.x ?? 0.5, frame?.pivot.y ?? 0.5, 0],
              axes: ["X", "Y"],
              onChange: ([x, y]) => {
                const frames = [...(sprite.frames ?? [])];
                if (frames[0]) {
                  frames[0] = { ...frames[0], pivot: { x, y } };
                }
                onChange({ ...sprite, frames });
              },
            },
          ]}
        />
      </div>
    </PanelFrame>
  );
}

function AnimGraphEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const doc = payload as unknown as AnimGraphDocument;
  const diagnostics = validateAnimGraph(doc).map((row) => ({
    nodeId: row.nodeId,
    severity: row.severity,
    message: row.message,
  }));
  const palette: PaletteNode[] = [
    { id: "anim.state", title: "State", category: "Animation" },
  ];
  return (
    <div className="flex min-h-0 flex-1" data-testid="anim-graph-editor">
      <GraphEditor
        initialGraph={animGraphToSerialized(doc)}
        diagnostics={diagnostics}
        paletteNodes={palette}
        onChange={(next) =>
          onChange(
            serializedToAnimGraph(next, doc) as unknown as Record<string, unknown>,
          )
        }
      />
    </div>
  );
}

function ShaderGraphEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const doc =
    (payload as unknown as ShaderGraphDocument) ?? createDefaultShaderGraph();
  const compiled = compileShaderGraph(doc);
  const diagnostics = validateShaderGraph(doc).map((row) => ({
    nodeId: row.nodeId,
    severity: row.severity,
    message: row.message,
  }));
  const palette: PaletteNode[] = SHADER_CATALOG.map((entry) => ({
    id: entry.type,
    title: entry.title,
    category: entry.category,
  }));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="shader-graph-editor">
      <p className="px-3 py-1 text-xs text-muted-foreground">
        {compiled.ipadCostWarning
          ? "Post-process materials are expensive on iPad and off by default"
          : "Surface shader"}
      </p>
      <GraphEditor
        initialGraph={shaderGraphToSerialized(doc)}
        diagnostics={diagnostics}
        paletteNodes={palette}
        onChange={(next) =>
          onChange(
            serializedToShaderGraph(next, doc) as unknown as Record<
              string,
              unknown
            >,
          )
        }
      />
    </div>
  );
}
