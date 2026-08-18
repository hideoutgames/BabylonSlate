import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  PanelFrame,
  PropertyGrid,
  TreeView,
  assetRowIdentity,
  type PropertyRow,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  isGltfModelBytes,
} from "@babylonslate/render";
import {
  normalizeSkeletonPayload,
  type SkeletonPayload,
} from "@babylonslate/assets";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { SkeletonPreviewCanvas } from "./skeleton-preview-canvas";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function useOwningModelBytes(modelGuid: string): Uint8Array | null {
  const { assetRegistry, readAssetChunk } = useDocuments();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const path = assetRegistry
    ?.list()
    .find((asset) => asset.header.guid === modelGuid)?.path;
  useEffect(() => {
    if (!path) {
      setBytes(null);
      return;
    }
    let cancelled = false;
    void readAssetChunk(path, "source").then((value) => {
      if (!cancelled) setBytes(value);
    });
    return () => {
      cancelled = true;
    };
  }, [path, readAssetChunk]);
  return bytes;
}

export function SkeletonPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const skeleton = normalizeSkeletonPayload(asRecord(doc?.content));
  const sourceBytes = useOwningModelBytes(skeleton.modelGuid);
  return (
    <PanelFrame data-testid="skeleton-preview-panel">
      <SkeletonPreview payload={skeleton} sourceBytes={sourceBytes} />
    </PanelFrame>
  );
}

export function SkeletonDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  return (
    <PanelFrame data-testid="skeleton-details-panel">
      <SkeletonEditor payload={asRecord(doc?.content)} />
    </PanelFrame>
  );
}

export function SkeletonPreview({
  payload,
  sourceBytes = null,
}: {
  payload: SkeletonPayload;
  sourceBytes?: Uint8Array | null;
}) {
  if (!sourceBytes || !isGltfModelBytes(sourceBytes)) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="skeleton-preview">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Mesh</EmptyTitle>
            <EmptyDescription>
              Open the owning Model to preview this skeleton.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0" data-testid="skeleton-preview">
      <SkeletonPreviewCanvas sourceBytes={sourceBytes} kind={payload.kind} />
    </div>
  );
}

export function SkeletonEditor({ payload }: { payload: Record<string, unknown> }) {
  const skeleton = normalizeSkeletonPayload(payload);
  const { assetRegistry } = useDocuments();
  const assets = assetRegistry?.list() ?? [];
  const model = assets.find((asset) => asset.header.guid === skeleton.modelGuid);
  const rows: PropertyRow[] = [
    {
      id: "kind",
      kind: "text",
      label: "Kind",
      value: skeleton.kind === "skin" ? "Skin" : "Hierarchy",
      disabled: true,
      onChange: () => {},
    },
    {
      id: "model",
      kind: "asset",
      label: "Model",
      value: skeleton.modelGuid || null,
      placeholder: "None",
      disabled: true,
      onPick: () => {},
      onChange: () => {},
      ...assetRowIdentity(
        model ? { name: model.header.name, type: "Model" } : undefined,
      ),
    },
  ];
  const boneNodes: TreeViewNode[] = skeleton.boneNames.map((name) => ({
    id: name,
    label: name,
    depth: 0,
    hasChildren: false,
    expanded: false,
  }));
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="skeleton-editor">
      <PropertyGrid rows={rows} />
      <div className="min-h-0 flex-1 p-2">
        <TreeView
          nodes={boneNodes}
          selectedId={null}
          onSelect={() => {}}
          emptyLabel="No bones"
          data-testid="skeleton-bone-tree"
        />
      </div>
    </div>
  );
}
