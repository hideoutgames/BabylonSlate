import type { IDockviewPanelProps } from "dockview-react";
import {
  curveKindForAssetType,
  curveTimeRange,
  documentKindLabel,
  isAssetDocumentKind,
  normalizeCurveAssetPayload,
  type CurveAssetPayload,
  type CurveKind,
} from "@haptic/core";
import { CurveEditor, GradientEditor, PanelFrame, PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import { FieldDescription } from "@haptic/ui/components/field";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

const KIND_BY_DOCUMENT: Record<string, CurveKind> = {
  "float-curve": "float",
  "vector-curve": "vec3",
  "color-curve": "color",
};

/** The open Curve asset: its kind, normalized payload and a commit that merges by `field` (one undo entry per gesture). */
function useCurveAsset() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const kind = KIND_BY_DOCUMENT[doc?.ref.kind ?? ""] ?? curveKindForAssetType(String(doc?.ref.kind)) ?? "float";
  const asset = normalizeCurveAssetPayload(kind, doc?.content);
  const commit = (next: CurveAssetPayload, field?: string) => {
    void applyAssetDocumentChange(
      documentId,
      normalizeCurveAssetPayload(kind, next) as unknown as Record<string, unknown>,
      field ? `curve-asset:${field}` : undefined,
    );
  };
  return { kind, asset, commit, label: doc && isAssetDocumentKind(doc.ref.kind) ? documentKindLabel(doc.ref.kind) : "Curve" };
}

/** Curve Editor window: a full-size plot; a Color Curve also shows its gradient above the channel curves. */
export function CurveAssetEditorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { kind, asset, commit, label } = useCurveAsset();
  return (
    <PanelFrame data-testid="curve-asset-editor-panel">
      <div className="flex min-w-0 flex-col gap-3 p-2">
        {kind === "color" ? (
          <GradientEditor aria-label={label} value={asset.curve} onChange={(curve) => commit({ ...asset, curve: curve as CurveAssetPayload["curve"] })} data-testid="curve-asset-gradient" />
        ) : null}
        <CurveEditor kind={kind} aria-label={label} value={asset.curve} onChange={(curve) => commit({ ...asset, curve: curve as CurveAssetPayload["curve"] })} data-testid="curve-asset-editor" />
      </div>
    </PanelFrame>
  );
}

/** Details window: what scripts read (key count and time span) and the Description. */
export function CurveAssetDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { asset, commit } = useCurveAsset();
  const range = curveTimeRange(asset.curve);
  const rows: PropertyRow[] = [
    { id: "curve-asset-keys", kind: "text", label: "Keys", value: String(asset.curve.Keys.length), readOnly: true, onChange: () => {} },
    { id: "curve-asset-time-range", kind: "text", label: "Time Range", value: `${range.Min.toFixed(2)} s – ${range.Max.toFixed(2)} s`, readOnly: true, onChange: () => {} },
    {
      id: "curve-asset-description", kind: "text", label: "Description", value: asset.description,
      onChange: () => {},
      onCommit: (description) => { if (description !== asset.description) commit({ ...asset, description }, "description"); },
    },
  ];
  return (
    <PanelFrame data-testid="curve-asset-details-panel">
      <div className="flex flex-col gap-2 p-2">
        <PropertyGrid rows={rows} />
        <FieldDescription className="px-2 text-xs">
          Scripts read this asset through its Get Curve Object node; the object is read-only.
        </FieldDescription>
      </div>
    </PanelFrame>
  );
}
