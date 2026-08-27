import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  NestedMenu,
  PanelFrame,
  PropertyGrid,
  TreeView,
  assetRowIdentity,
  type NestedMenuItem,
  type PropertyRow,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  SIMPLE_COLLIDER_KIND_LABELS,
  cookGeneratedCollisionFromGltf,
  createDefaultSimpleCollider,
  normalizeModelPayload,
  uniqueSimpleColliderName,
  type ModelPayload,
  type ModelSimpleCollider,
  type ModelSimpleColliderKind,
} from "@babylonslate/assets";
import { isGltfModelBytes } from "@babylonslate/render";
import {
  eulerDegreesToQuaternion,
  quaternionToEulerDegrees,
} from "@babylonslate/core";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useModelColliderSession } from "../context/model-collider-session";
import { ModelPreviewCanvas } from "./model-preview-canvas";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useModelSourceBytes(path: string | undefined): Uint8Array | null {
  const { readAssetChunk } = useDocuments();
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    if (!path) {
      setSourceBytes(null);
      return;
    }
    let cancelled = false;
    void readAssetChunk(path, "source").then((bytes) => {
      if (!cancelled) setSourceBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [path, readAssetChunk]);
  return sourceBytes;
}

export function ModelPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const sourceBytes = useModelSourceBytes(doc?.ref.path);
  return (
    <PanelFrame data-testid="model-preview-panel">
      <ModelPreview
        payload={asRecord(doc?.content)}
        sourceBytes={sourceBytes}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function ModelCollidersPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const sourceBytes = useModelSourceBytes(doc?.ref.path);
  return (
    <PanelFrame data-testid="model-colliders-panel">
      <ModelColliders
        payload={asRecord(doc?.content)}
        sourceBytes={sourceBytes}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function ModelDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  return (
    <PanelFrame data-testid="model-details-panel">
      <ModelEditor
        payload={asRecord(doc?.content)}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

export function ModelPreview({
  payload,
  sourceBytes = null,
  onChange,
}: {
  payload: Record<string, unknown>;
  sourceBytes?: Uint8Array | null;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  if (!sourceBytes || !isGltfModelBytes(sourceBytes)) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="model-preview">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Mesh</EmptyTitle>
            <EmptyDescription>
              OBJ and STL stay on this empty state. A glTF source loads in the
              Preview panel.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0" data-testid="model-preview">
      <ModelPreviewCanvas
        payload={payload}
        sourceBytes={sourceBytes}
        onChange={onChange}
      />
    </div>
  );
}

export function ModelEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const model = normalizeModelPayload(payload);
  const [pickIndex, setPickIndex] = useState<number | null>(null);
  const { assetRegistry } = useDocuments();
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));

  const commit = (next: ModelPayload) => {
    onChange(next as unknown as Record<string, unknown>);
  };

  const setSlotGuid = (index: number, materialGuid: string | null) => {
    commit({
      ...model,
      materialSlots: model.materialSlots.map((slot) =>
        slot.index === index ? { ...slot, materialGuid } : slot,
      ),
    });
  };

  const slotRows: PropertyRow[] = model.materialSlots.map((slot) => {
    const material = assets.find((asset) => asset.guid === slot.materialGuid);
    return {
      id: `slot-${slot.index}`,
      kind: "asset",
      label: slot.name,
      value: slot.materialGuid,
      placeholder: "Default",
      onPick: () => setPickIndex(slot.index),
      onChange: (value) => setSlotGuid(slot.index, value),
      ...assetRowIdentity(
        material ? { name: material.name, type: "Material" } : undefined,
      ),
    };
  });

  const clipRows: PropertyRow[] = model.clipNames.map((name, index) => ({
    id: `clip-${index}`,
    kind: "text",
    label: name,
    value: name,
    disabled: true,
    onChange: () => {},
  }));

  return (
    <div data-testid="model-editor">
      <PropertyGrid rows={slotRows} />
      {clipRows.length > 0 ? (
        <PropertyGrid title="Clips" rows={clipRows} />
      ) : null}
      <AssetPicker
        open={pickIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPickIndex(null);
        }}
        assets={assets}
        allowedTypes={["Material"]}
        onPick={(guid) => {
          if (pickIndex !== null) setSlotGuid(pickIndex, guid);
          setPickIndex(null);
        }}
        data-testid="model-material-picker"
      />
    </div>
  );
}

const ADD_COLLIDER_KINDS: ModelSimpleColliderKind[] = [
  "box",
  "sphere",
  "capsule",
  "cylinder",
  "cone",
  "generated",
];

function patchCollider(
  model: ModelPayload,
  id: string,
  patch: Partial<ModelSimpleCollider>,
): ModelPayload {
  return {
    ...model,
    simpleColliders: model.simpleColliders.map((collider) =>
      collider.id === id ? { ...collider, ...patch } : collider,
    ),
  };
}

function colliderPropertyRows(
  collider: ModelSimpleCollider,
  commit: (next: ModelSimpleCollider) => void,
): PropertyRow[] {
  const euler = quaternionToEulerDegrees(collider.rotation);
  const rows: PropertyRow[] = [
    {
      id: "name",
      kind: "text",
      label: "Name",
      value: collider.name,
      onChange: (value) => commit({ ...collider, name: value }),
    },
    {
      id: "position",
      kind: "vector3",
      label: "Position",
      value: collider.position,
      onChange: (value) =>
        commit({ ...collider, position: [value[0], value[1], value[2]] }),
    },
    {
      id: "rotation",
      kind: "vector3",
      label: "Rotation",
      value: euler,
      onChange: (value) =>
        commit({
          ...collider,
          rotation: eulerDegreesToQuaternion([value[0], value[1], value[2]]),
        }),
    },
    {
      id: "scale",
      kind: "vector3",
      label: "Scale",
      value: collider.scale,
      onChange: (value) =>
        commit({ ...collider, scale: [value[0], value[1], value[2]] }),
    },
  ];
  if (collider.kind === "box") {
    const extents = collider.halfExtents ?? { x: 0.5, y: 0.5, z: 0.5 };
    rows.push({
      id: "halfExtents",
      kind: "vector3",
      label: "Half Extents",
      value: [extents.x, extents.y, extents.z],
      onChange: (value) =>
        commit({
          ...collider,
          halfExtents: { x: value[0], y: value[1], z: value[2] },
        }),
    });
  }
  if (
    collider.kind === "sphere" ||
    collider.kind === "capsule" ||
    collider.kind === "cylinder" ||
    collider.kind === "cone"
  ) {
    rows.push({
      id: "radius",
      kind: "number",
      label: "Radius",
      value: collider.radius ?? 0.5,
      onChange: (value) => commit({ ...collider, radius: value }),
    });
  }
  if (collider.kind === "capsule") {
    rows.push({
      id: "halfHeight",
      kind: "number",
      label: "Half Height",
      value: collider.halfHeight ?? 0.5,
      onChange: (value) => commit({ ...collider, halfHeight: value }),
    });
  }
  if (collider.kind === "cylinder" || collider.kind === "cone") {
    rows.push({
      id: "height",
      kind: "number",
      label: "Height",
      value: collider.height ?? 1,
      onChange: (value) => commit({ ...collider, height: value }),
    });
  }
  return rows;
}

export function ModelColliders({
  payload,
  sourceBytes = null,
  onChange,
}: {
  payload: Record<string, unknown>;
  sourceBytes?: Uint8Array | null;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const model = normalizeModelPayload(payload);
  const { selectedColliderId, setSelectedColliderId } = useModelColliderSession();
  const selected =
    model.simpleColliders.find((entry) => entry.id === selectedColliderId) ??
    null;

  const commit = (next: ModelPayload) => {
    onChange(next as unknown as Record<string, unknown>);
  };

  const addKind = (kind: ModelSimpleColliderKind) => {
    if (kind === "generated" && !sourceBytes) return;
    const name = uniqueSimpleColliderName(
      model.simpleColliders,
      SIMPLE_COLLIDER_KIND_LABELS[kind],
    );
    const created =
      kind === "generated" && sourceBytes
        ? cookGeneratedCollisionFromGltf(sourceBytes, {
            importScale: model.importScale,
            name,
          })
        : createDefaultSimpleCollider(kind, { name });
    commit({
      ...model,
      simpleColliders: [...model.simpleColliders, created],
    });
    setSelectedColliderId(created.id);
  };

  const addItems: NestedMenuItem[] = ADD_COLLIDER_KINDS.map((kind) => ({
    id: kind,
    label: SIMPLE_COLLIDER_KIND_LABELS[kind],
    testId: `model-add-collider-${kind}`,
    disabled: kind === "generated" && !sourceBytes,
    onSelect: () => addKind(kind),
  }));

  const nodes: TreeViewNode[] = model.simpleColliders.map((collider) => ({
    id: collider.id,
    label: collider.name,
    depth: 0,
    hasChildren: false,
    expanded: false,
  }));

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="model-colliders"
    >
      <div className="flex items-center gap-1 border-b border-border p-2">
        <NestedMenu
          items={addItems}
          contentTestId="model-add-collider-menu"
          trigger={
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="model-add-collider"
            />
          }
        >
          Add
        </NestedMenu>
        <Button
          size="sm"
          variant="outline"
          data-testid="model-delete-collider"
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            commit({
              ...model,
              simpleColliders: model.simpleColliders.filter(
                (entry) => entry.id !== selected.id,
              ),
            });
            setSelectedColliderId(null);
          }}
        >
          Delete
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <TreeView
          nodes={nodes}
          selectedId={selectedColliderId}
          onSelect={(id) => setSelectedColliderId(id)}
          emptyLabel="No Colliders"
          data-testid="model-collider-tree"
        />
      </div>
      {selected ? (
        <PropertyGrid
          rows={colliderPropertyRows(selected, (next) =>
            commit(patchCollider(model, next.id, next)),
          )}
        />
      ) : null}
    </div>
  );
}

