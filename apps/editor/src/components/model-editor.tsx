import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { normalizeModelPayload, type ModelPayload } from "@babylonslate/assets";
import { isGltfModelBytes } from "@babylonslate/render";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOpenAssetDocument } from "../lib/use-open-asset-document";
import { ModelPreviewCanvas } from "./model-preview-canvas";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function ModelPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, readAssetChunk } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    const path = doc?.ref.path;
    if (!path) return;
    let cancelled = false;
    void readAssetChunk(path, "source").then((bytes) => {
      if (!cancelled) setSourceBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [doc?.ref.path, readAssetChunk]);
  return (
    <PanelFrame data-testid="model-preview-panel">
      <ModelPreview
        payload={asRecord(doc?.content)}
        sourceBytes={sourceBytes}
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
}: {
  payload: Record<string, unknown>;
  sourceBytes?: Uint8Array | null;
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
      <ModelPreviewCanvas payload={payload} sourceBytes={sourceBytes} />
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
  const openAssetDocument = useOpenAssetDocument();
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
      path: material?.path,
      onOpenAsset: material
        ? () => void openAssetDocument(material)
        : undefined,
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
