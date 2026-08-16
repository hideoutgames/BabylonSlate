import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PinListEditor,
  PropertyGrid,
  SelectableText,
  ToolbarStrip,
  type PinListRow,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@babylonslate/ui/components/empty";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { GraphEditor } from "@babylonslate/graph-ui";
import {
  MATERIAL_PREVIEW_MESHES,
  classifyMaterialCost,
  hydrateMaterialGraphForEditor,
  lowerMaterialDocument,
  materialGraphToSerialized,
  materialPaletteNodes,
  materialPinsAreCompatible,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  renderActionEnabled,
  serializedToMaterialFunctionGraph,
  serializedToMaterialGraph,
  validateMaterialDocument,
  validateMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialFunctionPin,
  type MaterialPreviewMesh,
} from "@babylonslate/shader-graph";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  useMaterialEditing,
  type MaterialEditingValue,
} from "../context/material-editing-context";

const PREVIEW_MESH_LABEL: Record<MaterialPreviewMesh, string> = {
  cube: "Cube",
  sphere: "Sphere",
  cylinder: "Cylinder",
  cone: "Cone",
  plane: "Plane",
  custom: "Custom",
};

function useMaterialDocument(): {
  documentId: string;
  document: MaterialDocument;
  commit: (next: MaterialDocument, mergeKey?: string) => void;
} {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const document = useMemo(
    () => normalizeMaterialDocument(doc?.content ?? {}),
    [doc?.content],
  );
  const commit = useCallback(
    (next: MaterialDocument, mergeKey?: string) => {
      void applyAssetDocumentChange(
        documentId,
        next as unknown as Record<string, unknown>,
        mergeKey,
      );
    },
    [applyAssetDocumentChange, documentId],
  );
  return { documentId, document, commit };
}

function useMaterialFunctionDocument(): {
  documentId: string;
  document: MaterialFunctionDocument;
  commit: (next: MaterialFunctionDocument, mergeKey?: string) => void;
} {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const document = useMemo(
    () => normalizeMaterialFunctionDocument(doc?.content ?? {}),
    [doc?.content],
  );
  const commit = useCallback(
    (next: MaterialFunctionDocument, mergeKey?: string) => {
      void applyAssetDocumentChange(
        documentId,
        next as unknown as Record<string, unknown>,
        mergeKey,
      );
    },
    [applyAssetDocumentChange, documentId],
  );
  return { documentId, document, commit };
}

export function MaterialGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit } = useMaterialDocument();
  const editing = useMaterialEditing();
  const functions = editing.functions;

  const diagnostics = useMemo(
    () =>
      validateMaterialDocument(document, {
        functions,
        warnPostProcessCost: true,
      }).map((row) => ({
        nodeId: row.nodeId,
        severity: row.severity,
        message: row.message,
      })),
    [document, functions],
  );

  const initialGraph = useMemo(
    () =>
      hydrateMaterialGraphForEditor(materialGraphToSerialized(document), {
        functions,
      }),
    [document, functions],
  );

  return (
    <PanelFrame className="flex-1" data-testid="material-graph-panel">
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-testid="material-graph-editor"
      >
        <GraphEditor
          initialGraph={initialGraph}
          diagnostics={diagnostics}
          paletteNodes={materialPaletteNodes(document.domain)}
          pinCompatibility={materialPinsAreCompatible}
          onSelectionChange={(ids) => editing.setSelectedNodeId(ids[0] ?? null)}
          focusedNodeId={editing.focusedNodeId ?? undefined}
          onChange={(next) => commit(serializedToMaterialGraph(next, document))}
        />
      </div>
    </PanelFrame>
  );
}

export function MaterialFunctionGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit } = useMaterialFunctionDocument();
  const editing = useMaterialEditing();

  const diagnostics = useMemo(
    () =>
      validateMaterialFunctionDocument(document, {
        functions: editing.functions,
      }).map((row) => ({
        nodeId: row.nodeId,
        severity: row.severity,
        message: row.message,
      })),
    [document, editing.functions],
  );

  const initialGraph = useMemo(
    () =>
      hydrateMaterialGraphForEditor(materialGraphToSerialized(document), {
        functions: editing.functions,
        functionInterface: document,
      }),
    [document, editing.functions],
  );

  return (
    <PanelFrame className="flex-1" data-testid="material-function-graph-panel">
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-testid="material-function-graph-editor"
      >
        <GraphEditor
          initialGraph={initialGraph}
          diagnostics={diagnostics}
          paletteNodes={materialPaletteNodes("surface")}
          pinCompatibility={materialPinsAreCompatible}
          onSelectionChange={(ids) => editing.setSelectedNodeId(ids[0] ?? null)}
          onChange={(next) =>
            commit(serializedToMaterialFunctionGraph(next, document))
          }
        />
      </div>
    </PanelFrame>
  );
}

/**
 * Preview dock: primitive picker, the Render control, and the live canvas the
 * render host draws into.
 */
export function MaterialPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit } = useMaterialDocument();
  const editing = useMaterialEditing();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meshPickOpen, setMeshPickOpen] = useState(false);
  const { assetRegistry } = useDocuments();

  useEffect(() => {
    editing.attachPreviewCanvas(canvasRef.current);
    return () => editing.attachPreviewCanvas(null);
  }, [editing]);

  const modelAssets = useMemo(
    () =>
      (assetRegistry?.list() ?? [])
        .filter((asset) => asset.header.type === "Model")
        .map((asset) => ({
          guid: asset.header.guid,
          name: asset.header.name,
          type: asset.header.type,
          path: asset.path,
        })),
    [assetRegistry],
  );

  const canRender = renderActionEnabled(editing.previewState);
  const status = editing.previewState.status;

  return (
    <PanelFrame className="flex-1" data-testid="material-preview-panel">
      <div className="flex min-h-0 flex-1 flex-col">
        <ToolbarStrip>
          <ToggleGroup
            variant="outline"
            size="touch"
            spacing={1}
            value={[document.preview.mesh]}
            onValueChange={(value) => {
              const next = value[0] as MaterialPreviewMesh | undefined;
              if (!next) return;
              commit({
                ...document,
                preview: {
                  mesh: next,
                  customMeshGuid:
                    next === "custom" ? document.preview.customMeshGuid : null,
                },
              });
              if (next === "custom" && !document.preview.customMeshGuid) {
                setMeshPickOpen(true);
              }
            }}
            aria-label="Preview Mesh"
            data-testid="material-preview-mesh"
          >
            {MATERIAL_PREVIEW_MESHES.map((mesh) => (
              <ToggleGroupItem
                key={mesh}
                value={mesh}
                aria-label={PREVIEW_MESH_LABEL[mesh]}
                data-testid={`material-preview-mesh-${mesh}`}
              >
                {PREVIEW_MESH_LABEL[mesh]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={!canRender}
            onClick={() => editing.requestRender()}
            data-testid="material-render"
          >
            Render
          </Button>
          <Badge data-testid="material-preview-status">{status}</Badge>
        </ToolbarStrip>
        {document.preview.mesh === "custom" ? (
          <div className="px-2 pb-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-[var(--touch-target,44px)] w-full justify-start"
              onClick={() => setMeshPickOpen(true)}
              data-testid="material-preview-custom-mesh"
            >
              {assetRegistry?.getByGuid(document.preview.customMeshGuid ?? "")
                ?.header.name ?? "Pick Mesh"}
            </Button>
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          data-testid="material-preview-canvas"
          data-status={status}
          data-ready-generation={editing.previewState.readyGeneration ?? -1}
          className="min-h-40 w-full flex-1 touch-none bg-background"
        />
        {editing.previewState.lastError ? (
          <p
            className="px-3 py-1 text-xs text-destructive"
            data-testid="material-preview-error"
          >
            <SelectableText>{editing.previewState.lastError}</SelectableText>
          </p>
        ) : null}
        <AssetPicker
          open={meshPickOpen}
          onOpenChange={setMeshPickOpen}
          assets={modelAssets}
          allowedTypes={["Model"]}
          title="Pick Preview Mesh"
          allowNone
          onPick={(guid) => {
            commit({
              ...document,
              preview: { mesh: "custom", customMeshGuid: guid ?? null },
            });
            setMeshPickOpen(false);
          }}
          data-testid="material-preview-mesh-picker"
        />
      </div>
    </PanelFrame>
  );
}

/** Domain, shading and blend settings plus the selected node's properties. */
export function MaterialDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const isFunction = doc?.ref.kind === "material-function";
  return isFunction ? (
    <MaterialFunctionDetails />
  ) : (
    <MaterialDocumentDetails />
  );
}

function MaterialDocumentDetails() {
  const { document, commit } = useMaterialDocument();
  const editing = useMaterialEditing();
  const rows: PropertyRow[] = [
    {
      id: "domain",
      kind: "enum",
      label: "Domain",
      value: document.domain,
      options: [
        { value: "surface", label: "Surface" },
        { value: "postProcess", label: "Post Process" },
      ],
      onChange: (value) =>
        commit({
          ...document,
          domain: value === "postProcess" ? "postProcess" : "surface",
        }),
    },
    {
      id: "shadingModel",
      kind: "enum",
      label: "Shading Model",
      value: document.shadingModel,
      options: [
        { value: "pbr", label: "PBR" },
        { value: "unlit", label: "Unlit" },
      ],
      onChange: (value) =>
        commit({
          ...document,
          shadingModel: value === "unlit" ? "unlit" : "pbr",
        }),
    },
    {
      id: "blendMode",
      kind: "enum",
      label: "Blend Mode",
      value: document.blendMode,
      options: [
        { value: "opaque", label: "Opaque" },
        { value: "masked", label: "Masked" },
        { value: "translucent", label: "Translucent" },
        { value: "additive", label: "Additive" },
      ],
      onChange: (value) =>
        commit({
          ...document,
          blendMode: value as MaterialDocument["blendMode"],
        }),
    },
    {
      id: "twoSided",
      kind: "boolean",
      label: "Two Sided",
      value: document.twoSided,
      onChange: (value) => commit({ ...document, twoSided: value }),
    },
  ];
  if (document.blendMode === "masked") {
    rows.push({
      id: "alphaCutoff",
      kind: "slider",
      label: "Alpha Cutoff",
      value: document.alphaCutoff,
      min: 0,
      max: 1,
      onChange: (value) => commit({ ...document, alphaCutoff: value }),
    });
  }

  return (
    <PanelFrame className="flex-1" data-testid="material-details-panel">
      <div className="flex flex-col gap-2">
        <PropertyGrid rows={rows} />
        <MaterialCostSummary />
        <MaterialNodeDetails
          document={document}
          commit={commit}
          selectedNodeId={editing.selectedNodeId}
        />
      </div>
    </PanelFrame>
  );
}

function MaterialCostSummary() {
  const { document } = useMaterialDocument();
  const editing = useMaterialEditing();
  const lowered = useMemo(
    () => lowerMaterialDocument(document, { functions: editing.functions }),
    [document, editing.functions],
  );
  if (!lowered.ok) return null;
  const cost = lowered.plan.cost;
  const costClass = classifyMaterialCost(cost, {
    frameBudgetMs: editing.frameBudgetMs,
    domain: document.domain,
    observedCompileMs: editing.previewState.compileSamplesMs,
  });
  return (
    <p
      className="px-3 text-xs text-muted-foreground"
      data-testid="material-cost"
      data-cost-class={costClass}
    >
      {cost.operations} operations · {cost.textureSamples} texture samples ·{" "}
      {costClass === "cheap" ? "renders automatically" : "press Render"}
    </p>
  );
}

/** Per-node properties for the selected graph node. */
function MaterialNodeDetails({
  document,
  commit,
  selectedNodeId,
}: {
  document: MaterialDocument;
  commit: (next: MaterialDocument) => void;
  selectedNodeId: string | null;
}) {
  const { assetRegistry } = useDocuments();
  const [pickOpen, setPickOpen] = useState(false);
  const node = document.nodes.find((entry) => entry.id === selectedNodeId);
  if (!node) return null;

  const setProperties = (properties: Record<string, unknown>) => {
    commit({
      ...document,
      nodes: document.nodes.map((entry) =>
        entry.id === node.id
          ? { ...entry, properties: { ...entry.properties, ...properties } }
          : entry,
      ),
    });
  };

  const rows: PropertyRow[] = [];
  if (node.type === "const.float" || node.type === "param.float") {
    const value = Array.isArray(node.properties.value)
      ? Number(node.properties.value[0] ?? 0)
      : 0;
    rows.push({
      id: "value",
      kind: "number",
      label: "Value",
      value,
      onChange: (next) => setProperties({ value: [next] }),
    });
  }
  if (node.type === "const.color" || node.type === "param.color") {
    const value = Array.isArray(node.properties.value)
      ? (node.properties.value as number[])
      : [1, 1, 1, 1];
    rows.push({
      id: "color",
      kind: "color",
      label: "Color",
      value: [value[0] ?? 1, value[1] ?? 1, value[2] ?? 1],
      onChange: (next) =>
        setProperties({ value: [next[0], next[1], next[2], value[3] ?? 1] }),
    });
  }
  if (node.type === "const.vec2" || node.type === "const.vec3" || node.type === "const.vec4") {
    const width = node.type === "const.vec2" ? 2 : node.type === "const.vec3" ? 3 : 4;
    const value = Array.isArray(node.properties.value)
      ? (node.properties.value as number[])
      : [];
    rows.push({
      id: "vector",
      kind: "vector3",
      label: "Value",
      value: [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0],
      axes: width === 2 ? ["X", "Y"] : ["X", "Y", "Z"],
      onChange: (next) => setProperties({ value: next }),
    });
  }

  const textureAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "Texture")
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));

  return (
    <div className="flex flex-col gap-2" data-testid="material-node-details">
      <p className="px-3 text-xs text-muted-foreground">{node.type}</p>
      {rows.length > 0 ? <PropertyGrid rows={rows} /> : null}
      {node.type === "param.texture" ? (
        <div className="px-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] w-full justify-start"
            onClick={() => setPickOpen(true)}
            data-testid="material-node-texture"
          >
            {assetRegistry?.getByGuid(
              typeof node.properties.textureGuid === "string"
                ? node.properties.textureGuid
                : "",
            )?.header.name ?? "Pick Texture"}
          </Button>
          <AssetPicker
            open={pickOpen}
            onOpenChange={setPickOpen}
            assets={textureAssets}
            allowedTypes={["Texture"]}
            title="Pick Texture"
            allowNone
            onPick={(guid) => {
              setProperties({ textureGuid: guid ?? null });
              setPickOpen(false);
            }}
            data-testid="material-node-texture-picker"
          />
        </div>
      ) : null}
      {node.type === "function.call" ? (
        <MaterialFunctionPicker node={node.id} document={document} commit={commit} />
      ) : null}
    </div>
  );
}

function MaterialFunctionPicker({
  node,
  document,
  commit,
}: {
  node: string;
  document: MaterialDocument;
  commit: (next: MaterialDocument) => void;
}) {
  const { assetRegistry } = useDocuments();
  const [open, setOpen] = useState(false);
  const current = document.nodes.find((entry) => entry.id === node);
  const guid =
    typeof current?.properties.functionGuid === "string"
      ? current.properties.functionGuid
      : "";
  const functionAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "MaterialFunction")
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  return (
    <div className="px-3">
      <Button
        type="button"
        variant="outline"
        className="min-h-[var(--touch-target,44px)] w-full justify-start"
        onClick={() => setOpen(true)}
        data-testid="material-node-function"
      >
        {assetRegistry?.getByGuid(guid)?.header.name ?? "Pick Material Function"}
      </Button>
      <AssetPicker
        open={open}
        onOpenChange={setOpen}
        assets={functionAssets}
        allowedTypes={["MaterialFunction"]}
        title="Pick Material Function"
        allowNone
        onPick={(picked) => {
          commit({
            ...document,
            nodes: document.nodes.map((entry) =>
              entry.id === node
                ? {
                    ...entry,
                    properties: { ...entry.properties, functionGuid: picked },
                  }
                : entry,
            ),
            // A different function has a different interface, so stale
            // connections to the old pins are dropped.
            edges: document.edges.filter(
              (edge) => edge.sourceNodeId !== node && edge.targetNodeId !== node,
            ),
          });
          setOpen(false);
        }}
        data-testid="material-node-function-picker"
      />
    </div>
  );
}

function MaterialFunctionDetails() {
  const { document, commit } = useMaterialFunctionDocument();
  return (
    <PanelFrame className="flex-1" data-testid="material-details-panel">
      <PropertyGrid
        rows={[
          {
            id: "description",
            kind: "text",
            label: "Description",
            value: document.description,
            onChange: (value) => commit({ ...document, description: value }),
          },
        ]}
      />
    </PanelFrame>
  );
}

const MATERIAL_FUNCTION_PIN_TYPES = [
  "float",
  "vec2",
  "vec3",
  "vec4",
] as const;

function toPinRows(pins: readonly MaterialFunctionPin[]): PinListRow[] {
  return pins.map((pin) => ({ id: pin.id, name: pin.name, type: pin.type }));
}

/** Pin ids stay stable across renames so existing call sites keep working. */
function fromPinRows(
  rows: readonly PinListRow[],
  prefix: "in" | "out",
): MaterialFunctionPin[] {
  return rows.map((row, index) => ({
    id: row.id || `${prefix}_${index}`,
    name: row.name,
    type: (MATERIAL_FUNCTION_PIN_TYPES as readonly string[]).includes(
      String(row.type),
    )
      ? (row.type as MaterialFunctionPin["type"])
      : "float",
  }));
}

/** Typed inputs and outputs of a Material Function. */
export function MaterialFunctionInterfacePanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit } = useMaterialFunctionDocument();
  return (
    <PanelFrame
      className="flex-1"
      title="Interface"
      data-testid="material-function-interface-panel"
    >
      <div className="flex flex-col gap-3 p-2">
        <PinListEditor
          title="Inputs"
          rows={toPinRows(document.inputs)}
          types={MATERIAL_FUNCTION_PIN_TYPES}
          onChange={(rows) =>
            commit({ ...document, inputs: fromPinRows(rows, "in") })
          }
          testIdPrefix="material-function-input"
          data-testid="material-function-inputs"
        />
        <PinListEditor
          title="Outputs"
          rows={toPinRows(document.outputs)}
          types={MATERIAL_FUNCTION_PIN_TYPES}
          onChange={(rows) =>
            commit({ ...document, outputs: fromPinRows(rows, "out") })
          }
          testIdPrefix="material-function-output"
          data-testid="material-function-outputs"
        />
      </div>
    </PanelFrame>
  );
}

/** Validation and compile diagnostics; tapping a row focuses its node. */
export function MaterialCompilerResultsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const editing = useMaterialEditing();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const isFunction = doc?.ref.kind === "material-function";

  const diagnostics = useMemo(() => {
    const payload = (doc?.content ?? {}) as Record<string, unknown>;
    if (isFunction) {
      return validateMaterialFunctionDocument(
        normalizeMaterialFunctionDocument(payload),
        { functions: editing.functions },
      );
    }
    return validateMaterialDocument(normalizeMaterialDocument(payload), {
      functions: editing.functions,
      warnPostProcessCost: true,
    });
  }, [doc?.content, editing.functions, isFunction]);

  const rows = [...diagnostics, ...editing.compileDiagnostics];

  return (
    <PanelFrame className="flex-1" data-testid="material-compiler-results">
      {rows.length === 0 ? (
        <Empty>
          <EmptyTitle>No Issues</EmptyTitle>
          <EmptyDescription>This material compiles cleanly.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="h-full">
          <ul className="flex flex-col gap-1 p-2">
            {rows.map((row, index) => (
              <li key={`${row.code}-${index}`}>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-[var(--touch-target,44px)] w-full justify-start text-left"
                  onClick={() => {
                    if (row.nodeId) editing.focusNode(row.nodeId);
                  }}
                  data-testid={`material-diagnostic-${row.code}`}
                  data-severity={row.severity}
                >
                  <Badge variant={row.severity === "error" ? "destructive" : "secondary"}>
                    {row.severity}
                  </Badge>
                  <SelectableText>{row.message}</SelectableText>
                </Button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </PanelFrame>
  );
}

export type { MaterialEditingValue };
