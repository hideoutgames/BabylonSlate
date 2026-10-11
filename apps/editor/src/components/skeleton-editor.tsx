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
import {
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { ModelSourceReadError, useModelSourceBytes } from "./model-editor";
import { SkeletonPreviewCanvas } from "./skeleton-preview-canvas";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function SkeletonPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  const { assetRegistry } = useRegistryState();
  const skeleton = normalizeSkeletonPayload(asRecord(doc?.content));
  const source = useModelSourceBytes(
    skeleton.modelGuid ? assetRegistry?.getByGuid(skeleton.modelGuid)?.path : undefined,
  );
  return (
    <PanelFrame data-testid="skeleton-preview-panel">
      <SkeletonPreview payload={skeleton} sourceBytes={source.bytes} sourceError={source.error} />
    </PanelFrame>
  );
}

export function SkeletonDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  return (
    <PanelFrame data-testid="skeleton-details-panel">
      <SkeletonEditor payload={asRecord(doc?.content)} />
    </PanelFrame>
  );
}

export function SkeletonPreview({
  payload,
  sourceBytes = null,
  sourceError = null,
}: {
  payload: SkeletonPayload;
  sourceBytes?: Uint8Array | null;
  /** Why the owning Model source could not be read, shown instead of a mesh. */
  sourceError?: string | null;
}) {
  if (sourceError) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="skeleton-preview">
        <ModelSourceReadError error={sourceError} />
      </div>
    );
  }
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
  const { assetRegistry } = useRegistryState();
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
