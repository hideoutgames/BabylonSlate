import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  TreeView,
  assetRowIdentity,
  type PropertyRow,
  type TreeViewNode,
} from "@haptic/editor-kit";
import {
  isGltfModelBytes,
} from "@haptic/render";
import {
  normalizeAnimationPayload,
  normalizeModelPayload,
  normalizeSkeletonPayload,
  quaternionToEulerDegrees,
  skeletonBoneTree,
  type SkeletonBone,
  type SkeletonPayload,
  type SkeletonRestChannel,
} from "@haptic/assets";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalSkeletonEditing } from "../context/skeleton-editing-context";
import { useModelSourceBytes } from "../lib/use-model-source-bytes";
import { ModelSourceReadError } from "./model-editor";
import { SkeletonPreviewCanvas } from "./skeleton-preview-canvas";
import { asRecord } from "../lib/as-record";

export function SkeletonPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  const { assetRegistry } = useRegistryState();
  const skeleton = normalizeSkeletonPayload(asRecord(doc?.content));
  const source = useModelSourceBytes(
    skeleton.modelGuid ? assetRegistry?.getByGuid(skeleton.modelGuid)?.path : undefined,
  );
  const selectedBone = useOptionalSkeletonEditing()?.selectedBone ?? null;
  return (
    <PanelFrame data-testid="skeleton-preview-panel">
      <SkeletonPreview payload={skeleton} sourceBytes={source.bytes} sourceError={source.error} selectedBone={selectedBone} />
    </PanelFrame>
  );
}

export function SkeletonDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const skeletonGuid = doc ? assetRegistry?.getByPath(doc.ref.path)?.header.guid ?? null : null;
  return (
    <PanelFrame data-testid="skeleton-details-panel">
      <SkeletonEditor
        payload={asRecord(doc?.content)}
        skeletonGuid={skeletonGuid}
        onChange={(next) => {
          void applyAssetDocumentChange(documentId, next);
        }}
      />
    </PanelFrame>
  );
}

function SkeletonPreview({
  payload,
  sourceBytes = null,
  sourceError = null,
  selectedBone = null,
}: {
  payload: SkeletonPayload;
  sourceBytes?: Uint8Array | null;
  /** Why the owning Model source could not be read, shown instead of a mesh. */
  sourceError?: string | null;
  /** The bone drawn highlighted. */
  selectedBone?: string | null;
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
              Pick a Preview Model to preview this Skeleton.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0" data-testid="skeleton-preview">
      <SkeletonPreviewCanvas sourceBytes={sourceBytes} kind={payload.kind} selectedBone={selectedBone} />
    </div>
  );
}

const AXES_DEGREES = "°";

function SkeletonEditor({
  payload,
  skeletonGuid,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** The open Skeleton's own guid, which its Models name. */
  skeletonGuid: string | null;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  const skeleton = normalizeSkeletonPayload(payload);
  const { assetRegistry } = useRegistryState();
  const editing = useOptionalSkeletonEditing();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const assets = assetRegistry?.list() ?? [];
  const model = assets.find((asset) => asset.header.guid === skeleton.modelGuid);
  // Any Model on this Skeleton can be the preview.
  const models = skeletonGuid
    ? assets.filter((asset) => asset.header.type === "Model" &&
      normalizeModelPayload(asset.header.payload ?? {}).skeletonGuid === skeletonGuid)
    : [];
  const animationCount = skeletonGuid
    ? assets.filter((asset) => asset.header.type === "Animation" &&
      normalizeAnimationPayload(asset.header.payload ?? {}).skeletonGuid === skeletonGuid).length
    : 0;
  const rows: PropertyRow[] = [
    {
      id: "kind",
      kind: "info",
      label: "Kind",
      value: skeleton.kind === "skin" ? "Skin" : "Hierarchy",
    },
    {
      id: "model",
      kind: "asset",
      label: "Preview Model",
      value: skeleton.modelGuid || null,
      placeholder: "None",
      assetTypes: ["Model"],
      disabled: !onChange,
      onPick: () => setModelPickerOpen(true),
      onChange: (guid) => {
        if (guid && models.some((entry) => entry.header.guid === guid)) onChange?.({ ...payload, modelGuid: guid });
      },
      ...assetRowIdentity(
        model ? { name: model.header.name, type: "Model" } : undefined,
      ),
    },
    { id: "models", kind: "info", label: "Models", value: String(models.length) },
    { id: "animations", kind: "info", label: "Animations", value: String(animationCount) },
    { id: "bones", kind: "info", label: "Bones", value: String(skeleton.bones.length) },
  ];
  const selected = skeleton.bones.find((bone) => bone.name === editing?.selectedBone) ?? null;
  const boneRows: PropertyRow[] = selected
    ? [
        { id: "bone-parent", kind: "info", label: "Parent", value: selected.parent ?? "None" },
        ...restRow(selected, "position", "Rest Position", selected.position),
        ...restRow(selected, "rotation", "Rest Rotation", quaternionToEulerDegrees(selected.rotation), AXES_DEGREES),
        ...restRow(selected, "scale", "Rest Scale", selected.scale),
      ]
    : [];
  const visible: TreeViewNode[] = [];
  let hiddenBelow: number | null = null;
  for (const { bone, depth, hasChildren } of skeletonBoneTree(skeleton.bones)) {
    if (hiddenBelow !== null && depth > hiddenBelow) continue;
    hiddenBelow = null;
    const expanded = !collapsed.has(bone.name);
    if (hasChildren && !expanded) hiddenBelow = depth;
    visible.push({ id: bone.name, label: bone.name, depth, hasChildren, expanded });
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="skeleton-editor">
      <PropertyGrid rows={rows} />
      <div className="min-h-0 flex-1 p-2">
        <TreeView
          nodes={visible}
          selectedId={editing?.selectedBone ?? null}
          onSelect={(id) => editing?.setSelectedBone(editing.selectedBone === id ? null : id)}
          onToggleExpanded={(id) => setCollapsed((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
          })}
          emptyLabel="No bones"
          data-testid="skeleton-bone-tree"
        />
      </div>
      {boneRows.length > 0 ? (
        <div className="border-t border-border" data-testid="skeleton-bone-details">
          <PropertyGrid rows={boneRows} />
        </div>
      ) : null}
      <AssetPicker
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        assets={models.map((asset) => ({
          guid: asset.header.guid,
          name: asset.header.name,
          type: asset.header.type,
          path: asset.path,
        }))}
        allowedTypes={["Model"]}
        title="Pick Preview Model"
        allowNone={false}
        onPick={(guid) => {
          setModelPickerOpen(false);
          if (guid) onChange?.({ ...payload, modelGuid: guid });
        }}
        data-testid="skeleton-preview-model-picker"
      />
    </div>
  );
}

/** A read-only rest channel; an animation library's posed channel says so instead of showing a clip's frame. */
function restRow(
  bone: SkeletonBone,
  channel: SkeletonRestChannel,
  label: string,
  value: readonly number[],
  unit?: string,
): PropertyRow[] {
  const id = `bone-${channel}`;
  if (bone.posed?.includes(channel)) return [{ id, kind: "info", label, value: "Unknown" }];
  const rounded = value.map((entry) => Math.round(entry * 1000) / 1000);
  return [{
    id,
    kind: "vector3",
    label,
    value: [rounded[0]!, rounded[1]!, rounded[2]!],
    disabled: true,
    ...(unit ? { unit } : {}),
    onChange: () => {},
  }];
}
