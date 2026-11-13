import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  PanelFrame,
  PropertyGrid,
  ToolbarStrip,
  assetRowIdentity,
  type PropertyRow,
} from "@haptic/editor-kit";
import { isGltfModelBytes } from "@haptic/render";
import {
  normalizeAnimationPayload,
  normalizeModelPayload,
  normalizeSkeletonPayload,
  type AnimationPayload,
  type ModelMaterialSlot,
  type SkeletonKind,
} from "@haptic/assets";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { Toggle } from "@haptic/ui/components/toggle";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { AnimationPreviewCanvas } from "./animation-preview-canvas";
import { ModelSourceReadError } from "./model-editor";
import { asRecord } from "../lib/as-record";
import { useModelSourceBytes } from "../lib/use-model-source-bytes";

export function AnimationPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const animation = normalizeAnimationPayload(asRecord(doc?.content));
  const model = animation.modelGuid
    ? assetRegistry?.getByGuid(animation.modelGuid)
    : undefined;
  const source = useModelSourceBytes(model?.path);
  const materialSlots =
    model?.header.type === "Model"
      ? normalizeModelPayload(model.header.payload ?? {}).materialSlots
      : [];
  const sourceAnim = animation.sourceAnimationGuid
    ? assetRegistry?.getByGuid(animation.sourceAnimationGuid)
    : undefined;
  const sourceModelGuid =
    sourceAnim && sourceAnim.header.type === "Animation"
      ? normalizeAnimationPayload(sourceAnim.header.payload ?? {}).modelGuid
      : null;
  const sourceClip = useModelSourceBytes(
    sourceModelGuid ? assetRegistry?.getByGuid(sourceModelGuid)?.path : undefined,
  );
  const skeleton = animation.skeletonGuid
    ? assetRegistry?.getByGuid(animation.skeletonGuid)
    : undefined;
  const skeletonKind: SkeletonKind | null = skeleton
    ? normalizeSkeletonPayload(skeleton.header.payload ?? {}).kind
    : null;
  const [showBones, setShowBones] = useState(false);
  return (
    <PanelFrame data-testid="animation-preview-panel">
      <AnimationPreview
        payload={animation}
        sourceBytes={source.bytes}
        sourceError={source.error ?? sourceClip.error}
        materialSlots={materialSlots}
        sourceClipBytes={sourceClip.bytes}
        skeletonKind={skeletonKind}
        showBones={showBones}
        onShowBonesChange={setShowBones}
      />
    </PanelFrame>
  );
}

export function AnimationDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  return (
    <PanelFrame data-testid="animation-details-panel">
      <AnimationEditor
        payload={asRecord(doc?.content)}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

/** Preview playback rate that makes one pass of the clip last the authored Duration. */
function previewSpeedRatio(payload: AnimationPayload): number {
  const { durationMs, clipDurationMs } = payload;
  return durationMs !== undefined && clipDurationMs !== undefined
    ? clipDurationMs / durationMs
    : 1;
}

export function AnimationPreview({
  payload,
  sourceBytes = null,
  sourceError = null,
  materialSlots,
  sourceClipBytes = null,
  skeletonKind = null,
  showBones = false,
  onShowBonesChange,
}: {
  payload: AnimationPayload;
  sourceBytes?: Uint8Array | null;
  /** Why the Model source or the retarget source clip could not be read, shown instead of a mesh. */
  sourceError?: string | null;
  materialSlots: readonly ModelMaterialSlot[];
  sourceClipBytes?: Uint8Array | null;
  skeletonKind?: SkeletonKind | null;
  showBones?: boolean;
  onShowBonesChange?: (value: boolean) => void;
}) {
  // A Model with nothing to draw (an animation library) always shows its bones.
  const [bonesOnly, setBonesOnly] = useState(false);
  if (sourceError) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="animation-preview">
        <ModelSourceReadError error={sourceError} />
      </div>
    );
  }
  if (!sourceBytes || !isGltfModelBytes(sourceBytes)) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="animation-preview">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Mesh</EmptyTitle>
            <EmptyDescription>
              Open the owning Model to preview this clip.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="animation-preview"
    >
      <ToolbarStrip data-testid="animation-preview-toolbar">
        <Toggle
          size="sm"
          variant="outline"
          pressed={showBones || bonesOnly}
          disabled={bonesOnly}
          aria-label="Show Bones"
          data-testid="animation-show-bones"
          onPressedChange={(pressed) => onShowBonesChange?.(pressed)}
        >
          Show Bones
        </Toggle>
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <AnimationPreviewCanvas
          sourceBytes={sourceBytes}
          materialSlots={materialSlots}
          clipName={payload.clipName}
          skeletonKind={skeletonKind}
          showBones={showBones}
          speedRatio={previewSpeedRatio(payload)}
          onBonesOnlyChange={setBonesOnly}
          sourceClipBytes={
            payload.sourceAnimationGuid ? sourceClipBytes : null
          }
        />
      </div>
    </div>
  );
}

export function AnimationEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** Omitted: every row is read-only. */
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const animation = normalizeAnimationPayload(payload);
  const { assetRegistry } = useRegistryState();
  const assets = assetRegistry?.list() ?? [];
  const model = assets.find((asset) => asset.header.guid === animation.modelGuid);
  const skeleton = animation.skeletonGuid
    ? assets.find((asset) => asset.header.guid === animation.skeletonGuid)
    : undefined;
  const rows: PropertyRow[] = [
    {
      id: "clipName",
      kind: "text",
      label: "Clip Name",
      value: animation.clipName,
      disabled: true,
      onChange: () => {},
    },
    {
      id: "model",
      kind: "asset",
      label: "Model",
      value: animation.modelGuid || null,
      placeholder: "None",
      disabled: true,
      onPick: () => {},
      onChange: () => {},
      ...assetRowIdentity(
        model ? { name: model.header.name, type: "Model" } : undefined,
      ),
    },
    {
      id: "skeleton",
      kind: "asset",
      label: "Skeleton",
      value: animation.skeletonGuid,
      placeholder: "None",
      disabled: true,
      onPick: () => {},
      onChange: () => {},
      ...assetRowIdentity(
        skeleton
          ? { name: skeleton.header.name, type: "Skeleton" }
          : undefined,
      ),
    },
  ];
  if (animation.durationMs !== undefined) {
    rows.push({
      id: "durationMs",
      kind: "number",
      label: "Duration",
      unit: "ms",
      value: animation.durationMs,
      defaultValue: animation.clipDurationMs,
      min: 1,
      disabled: !onChange,
      onChange: (durationMs) =>
        onChange?.(
          { ...payload, ...animation, durationMs: Math.max(1, durationMs) },
          "animation:durationMs",
        ),
    });
  }
  return (
    <div data-testid="animation-editor">
      <PropertyGrid rows={rows} />
    </div>
  );
}
