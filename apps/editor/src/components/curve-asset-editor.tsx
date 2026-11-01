import { useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  CURVE_EXTRAPOLATIONS,
  curveKindForAssetType,
  curveTimeRange,
  documentKindLabel,
  isAssetDocumentKind,
  normalizeCurveAssetPayload,
  type CurveAssetPayload,
  type CurveExtrapolation,
  type CurveKind,
} from "@haptic/core";
import { CurveEditor, PanelFrame, PropertyGrid, type CurveEditorHandle, type PropertyRow } from "@haptic/editor-kit";
import { FieldDescription } from "@haptic/ui/components/field";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useKeybindChord, useKeybindCommand } from "../context/keybind-context";

const KIND_BY_DOCUMENT: Record<string, CurveKind> = {
  "float-curve": "float",
  "vector-curve": "vec3",
  "color-curve": "color",
};

const EXTRAPOLATION_OPTIONS = CURVE_EXTRAPOLATIONS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));

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

/** Lowest and highest key value across every channel, or null without keys. */
function keyValueRange(kind: CurveKind, keys: readonly { Value: unknown }[]): [number, number] | null {
  const channels = kind === "float" ? [] : kind === "vec3" ? ["x", "y", "z"] : ["x", "y", "z", "w"];
  const values = keys.flatMap((key) => (kind === "float"
    ? [Number(key.Value)]
    : channels.map((channel) => Number((key.Value as Record<string, unknown>)[channel]))))
    .filter(Number.isFinite);
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

/**
 * Curve Editor window: the plot fills the window between a toolbar and the selected key's bar; a Color
 * Curve adds a gradient lane whose stops are the keys. Frame Selection (F) fits the keys.
 */
export function CurveAssetEditorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { kind, asset, commit, label } = useCurveAsset();
  const panelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CurveEditorHandle>(null);
  const fitChord = useKeybindChord("viewport.frameSelection");
  useKeybindCommand("viewport.frameSelection", () => editorRef.current?.fit(), { scopeRef: panelRef });
  return (
    <PanelFrame data-testid="curve-asset-editor-panel">
      <div ref={panelRef} className="flex h-full min-h-0 min-w-0 flex-col">
        <CurveEditor
          ref={editorRef}
          layout="window"
          kind={kind}
          aria-label={label}
          value={asset.curve}
          fitShortcut={fitChord}
          onChange={(curve) => commit({ ...asset, curve: curve as CurveAssetPayload["curve"] })}
          data-testid="curve-asset-editor"
        />
      </div>
    </PanelFrame>
  );
}

/** Details window: what scripts read (key count, time and value range), Before and After, and the Description. */
export function CurveAssetDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { kind, asset, commit, label } = useCurveAsset();
  const keys = asset.curve.Keys;
  const time = curveTimeRange(asset.curve);
  const values = keyValueRange(kind, keys);
  const facts: PropertyRow[] = [
    { id: "curve-asset-type", kind: "info", label: "Type", value: label },
    { id: "curve-asset-keys", kind: "info", label: "Keys", value: String(keys.length) },
    { id: "curve-asset-time-range", kind: "info", label: "Time Range", value: keys.length ? `${time.Min.toFixed(2)} – ${time.Max.toFixed(2)} s` : "None" },
    { id: "curve-asset-value-range", kind: "info", label: "Value Range", value: values ? `${values[0].toFixed(2)} – ${values[1].toFixed(2)}` : "None" },
  ];
  const extrapolation: PropertyRow[] = (["Before", "After"] as const).map((end) => ({
    id: `curve-asset-${end.toLowerCase()}`,
    kind: "enum",
    label: end,
    value: asset.curve[end],
    options: EXTRAPOLATION_OPTIONS,
    onChange: (next: string) => {
      if (next !== asset.curve[end]) commit({ ...asset, curve: { ...asset.curve, [end]: next as CurveExtrapolation } });
    },
  }));
  const description: PropertyRow[] = [{
    id: "curve-asset-description", kind: "text", multiline: true, label: "Description", value: asset.description,
    onChange: () => {},
    onCommit: (next) => { if (next !== asset.description) commit({ ...asset, description: next }, "description"); },
  }];
  return (
    <PanelFrame data-testid="curve-asset-details-panel">
      <div className="flex flex-col pb-2">
        <PropertyGrid title="Curve" rows={facts} />
        <PropertyGrid title="Extrapolation" rows={extrapolation} />
        <PropertyGrid title="Description" rows={description} hideLabels />
        <FieldDescription className="px-2 text-xs">
          Scripts read this asset through its Get Curve Object node; the object is read-only.
        </FieldDescription>
      </div>
    </PanelFrame>
  );
}
