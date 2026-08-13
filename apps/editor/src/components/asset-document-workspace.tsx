import { useEffect, useState } from "react";
import { PanelFrame, ParameterListEditor, PropertyGrid, SelectableText, TreeView } from "@babylonslate/editor-kit";
import type { ParameterRow, PropertyRow, TreeViewNode } from "@babylonslate/editor-kit";
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
  createWidget,
  describeUiControls,
  glyphsFallingToFallback,
  layoutUserInterface,
  type DevicePreset,
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
import { FontRegistry } from "@babylonslate/render";
import { asUiDocument } from "../lib/play-content";
import { familyFromAssetPayload, fontEditorStack } from "../lib/font-preview";
import {
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
} from "../services/graph-validation";
import {
  addEnumMember,
  addScriptInterfaceMethod,
  addStructureField,
  patchTextureUsage,
  TEXTURE_USAGE_OPTIONS,
} from "../lib/asset-settings";
import type {
  EnumAsset,
  ScriptInterfaceAsset,
  StructureAsset,
} from "@babylonslate/scripting";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function AssetDocumentWorkspace({ documentId }: { documentId: string }) {
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  if (!doc) return null;
  const payload = asRecord(doc.content);
  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
  };
  if (doc.ref.kind === "ui") return <UiDesigner payload={payload} onChange={commit} />;
  if (doc.ref.kind === "font") {
    return (
      <FontEditor
        path={doc.ref.path}
        payload={payload}
        onChange={commit}
      />
    );
  }
  if (doc.ref.kind === "sprite") return <SpriteEditor payload={payload} onChange={commit} />;
  if (doc.ref.kind === "anim-graph") {
    return <AnimGraphEditor payload={payload} onChange={commit} />;
  }
  if (doc.ref.kind === "shader") {
    return <ShaderGraphEditor payload={payload} onChange={commit} />;
  }
  if (doc.ref.kind === "asset-settings") {
    const indexed = assetRegistry
      ?.list()
      .find((asset) => asset.path === doc.ref.path);
    return (
      <AssetSettingsEditor
        assetType={indexed?.header.type ?? "Texture"}
        dependencies={indexed?.header.dependencies ?? []}
        payload={payload}
        onChange={commit}
      />
    );
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
                data-gui-x={String(Math.round(control.guiRect.x))}
                data-gui-y={String(Math.round(control.guiRect.y))}
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
  path,
  payload,
  onChange,
}: {
  path: string;
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { projectDocument, assetRegistry, readAssetChunk } = useDocuments();
  const font = normalizeFontPayload(payload, "Custom Font");
  const [sample, setSample] = useState("The quick brown fox");
  const [fontsReady, setFontsReady] = useState(false);
  const familyForGuid = (guid: string): string | null => {
    const asset = assetRegistry?.getByGuid(guid);
    return familyFromAssetPayload(asset?.header.payload);
  };
  const stack = fontEditorStack({
    family: font.family,
    fallbackGuids: font.fallbackGuids,
    defaultFontGuid: projectDocument?.settings.fonts.defaultFontGuid ?? null,
    globalFallback: projectDocument?.settings.fonts.globalFallback ?? "sans-serif",
    familyForGuid,
  });
  useEffect(() => {
    let cancelled = false;
    const registry = new FontRegistry();
    void (async () => {
      const bytes = await readAssetChunk(path, "source");
      if (bytes && bytes.byteLength > 0) {
        const guid = assetRegistry?.list().find((asset) => asset.path === path)
          ?.header.guid ?? path;
        await registry.register({
          guid,
          family: font.family,
          bytes: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          weight: font.weight,
          style: font.style,
        });
      }
      if (!cancelled) setFontsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    assetRegistry,
    font.family,
    font.style,
    font.weight,
    path,
    readAssetChunk,
  ]);
  const flagged = glyphsFallingToFallback(
    sample,
    font.family,
    (text, measureStack) => {
      if (typeof document === "undefined") {
        return measureStack.includes(font.family) && /[A-Za-z]/.test(text)
          ? 10
          : 7;
      }
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return 0;
      ctx.font = `16px ${measureStack}`;
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
          data-fonts-ready={fontsReady ? "true" : "false"}
          data-font-stack={stack}
          style={{ fontFamily: stack }}
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

function asEnumAsset(payload: Record<string, unknown>): EnumAsset {
  const members = Array.isArray(payload.members) ? payload.members : [];
  return {
    kind: "enum",
    guid: typeof payload.guid === "string" ? payload.guid : "",
    name: typeof payload.name === "string" ? payload.name : "Enum",
    members: members.map((raw) => {
      const row = asRecord(raw);
      return {
        name: typeof row.name === "string" ? row.name : "Member",
        value: typeof row.value === "number" ? row.value : 0,
      };
    }),
  };
}

function asStructureAsset(payload: Record<string, unknown>): StructureAsset {
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  return {
    kind: "structure",
    guid: typeof payload.guid === "string" ? payload.guid : "",
    name: typeof payload.name === "string" ? payload.name : "Structure",
    fields: fields.map((raw) => {
      const row = asRecord(raw);
      return {
        name: typeof row.name === "string" ? row.name : "Field",
        typeId: typeof row.typeId === "string" ? row.typeId : "float",
      };
    }),
  };
}

function asScriptInterfaceAsset(
  payload: Record<string, unknown>,
): ScriptInterfaceAsset {
  const methods = Array.isArray(payload.methods) ? payload.methods : [];
  return {
    kind: "scriptInterface",
    guid: typeof payload.guid === "string" ? payload.guid : "",
    name: typeof payload.name === "string" ? payload.name : "Interface",
    methods: methods.map((raw) => {
      const row = asRecord(raw);
      const pins = Array.isArray(row.pins) ? row.pins : [];
      return {
        name: typeof row.name === "string" ? row.name : "Method",
        pins: pins.map((pin) => {
          const pinRow = asRecord(pin);
          return {
            name: typeof pinRow.name === "string" ? pinRow.name : "Pin",
            typeId: typeof pinRow.typeId === "string" ? pinRow.typeId : "float",
            direction: pinRow.direction === "out" ? "out" : "in",
          };
        }),
      };
    }),
  };
}

function AssetSettingsEditor({
  assetType,
  dependencies,
  payload,
  onChange,
}: {
  assetType: string;
  dependencies: string[];
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  if (assetType === "Enum") {
    const asset = asEnumAsset(payload);
    return (
      <PanelFrame className="flex-1" title="Enum">
        <div className="flex flex-col gap-3 p-3" data-testid="enum-settings">
          {asset.members.map((member, index) => (
            <PropertyGrid
              key={`${member.name}-${index}`}
              rows={[
                {
                  id: `name-${index}`,
                  kind: "text",
                  label: "Name",
                  value: member.name,
                  onChange: (value) => {
                    const members = [...asset.members];
                    members[index] = { ...member, name: value };
                    onChange({ ...asset, members });
                  },
                },
                {
                  id: `value-${index}`,
                  kind: "number",
                  label: "Value",
                  value: member.value,
                  onChange: (value) => {
                    const members = [...asset.members];
                    members[index] = { ...member, value };
                    onChange({ ...asset, members });
                  },
                },
              ]}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(addEnumMember(asset))}
          >
            Add Member
          </Button>
        </div>
      </PanelFrame>
    );
  }

  if (assetType === "Structure") {
    const asset = asStructureAsset(payload);
    return (
      <PanelFrame className="flex-1" title="Structure">
        <div className="flex flex-col gap-3 p-3" data-testid="structure-settings">
          {asset.fields.map((field, index) => (
            <PropertyGrid
              key={`${field.name}-${index}`}
              rows={[
                {
                  id: `name-${index}`,
                  kind: "text",
                  label: "Name",
                  value: field.name,
                  onChange: (value) => {
                    const fields = [...asset.fields];
                    fields[index] = { ...field, name: value };
                    onChange({ ...asset, fields });
                  },
                },
                {
                  id: `type-${index}`,
                  kind: "text",
                  label: "Type",
                  value: field.typeId,
                  onChange: (value) => {
                    const fields = [...asset.fields];
                    fields[index] = { ...field, typeId: value };
                    onChange({ ...asset, fields });
                  },
                },
              ]}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(addStructureField(asset))}
          >
            Add Field
          </Button>
        </div>
      </PanelFrame>
    );
  }

  if (assetType === "ScriptInterface") {
    const asset = asScriptInterfaceAsset(payload);
    return (
      <PanelFrame className="flex-1" title="Script Interface">
        <div className="flex flex-col gap-4 p-3" data-testid="script-interface-settings">
          {asset.methods.map((method, index) => {
            const rows: ParameterRow[] = method.pins.map((pin, pinIndex) => ({
              id: `${index}-${pinIndex}-${pin.name}`,
              name: pin.name,
              type:
                pin.typeId === "int" ||
                pin.typeId === "bool" ||
                pin.typeId === "string" ||
                pin.typeId === "enum"
                  ? pin.typeId
                  : "float",
            }));
            return (
              <div key={`${method.name}-${index}`} className="flex flex-col gap-2">
                <PropertyGrid
                  rows={[
                    {
                      id: `method-${index}`,
                      kind: "text",
                      label: "Method",
                      value: method.name,
                      onChange: (value) => {
                        const methods = [...asset.methods];
                        methods[index] = { ...method, name: value };
                        onChange({ ...asset, methods });
                      },
                    },
                  ]}
                />
                <ParameterListEditor
                  title="Pins"
                  rows={rows}
                  onChange={(nextRows) => {
                    const methods = [...asset.methods];
                    methods[index] = {
                      ...method,
                      pins: nextRows.map((row) => ({
                        name: row.name,
                        typeId: row.type,
                        direction: "in" as const,
                      })),
                    };
                    onChange({ ...asset, methods });
                  }}
                />
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(addScriptInterfaceMethod(asset))}
          >
            Add Method
          </Button>
        </div>
      </PanelFrame>
    );
  }

  const rows: PropertyRow[] = [];
  if (assetType === "Texture") {
    const usage = typeof payload.usage === "string" ? payload.usage : "albedo";
    const compression =
      typeof payload.compressionState === "string"
        ? payload.compressionState
        : "none";
    rows.push(
      {
        id: "usage",
        kind: "enum",
        label: "Usage",
        value: usage,
        options: TEXTURE_USAGE_OPTIONS.map((value) => ({
          value,
          label:
            value === "pixelArt"
              ? "Pixel Art"
              : value === "ui"
                ? "UI"
                : value.charAt(0).toUpperCase() + value.slice(1),
        })),
        onChange: (value) => onChange(patchTextureUsage(payload, value)),
      },
      {
        id: "compression",
        kind: "text",
        label: "Compression",
        value: compression,
        disabled: true,
        onChange: () => undefined,
      },
    );
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "number") {
        rows.push({
          id: key,
          kind: "number",
          label: key,
          value,
          onChange: (next) => onChange({ ...payload, [key]: next }),
        });
      } else if (typeof value === "boolean") {
        rows.push({
          id: key,
          kind: "boolean",
          label: key,
          value,
          onChange: (next) => onChange({ ...payload, [key]: next }),
        });
      } else if (typeof value === "string") {
        rows.push({
          id: key,
          kind: "text",
          label: key,
          value,
          onChange: (next) => onChange({ ...payload, [key]: next }),
        });
      }
    }
  }
  if (dependencies.length > 0) {
    rows.push({
      id: "dependencies",
      kind: "text",
      label: "Dependencies",
      value: String(dependencies.length),
      disabled: true,
      onChange: () => undefined,
    });
  }

  return (
    <PanelFrame className="flex-1" title={assetType}>
      <div data-testid="asset-settings">
        <PropertyGrid rows={rows} />
      </div>
    </PanelFrame>
  );
}
