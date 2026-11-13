import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { blendSpaceTriangles, blendSpaceWeights } from "@haptic/anim-graph";
import {
  normalizeAnimationPayload,
  normalizeBlendSpacePayload,
  type BlendSpaceAxisPayload,
  type BlendSpacePayload,
} from "@haptic/assets";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  assetRowIdentity,
  type PropertyRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useBlendSpaceEditing } from "../context/blend-space-editing-context";
import { asRecord } from "../lib/as-record";
import {
  addBlendSpaceSample,
  blendSpaceLayoutOf,
  blendSpacePreviewPoint,
  moveBlendSpaceSample,
  patchBlendSpaceAxis,
  patchBlendSpaceSample,
  removeBlendSpaceSample,
  setBlendSpaceAxisCount,
  snapToBlendSpaceGrid,
} from "../lib/blend-space-editing";
import { IconActionButton } from "./icon-action-button";

/** The drag type an Animation row carries onto the Grid. */
const BLEND_SPACE_ANIMATION_DRAG = "application/x-haptic-blend-space-animation";

/** The open Blend Space, parsed, and a writer that keeps the document's other fields. */
// eslint-disable-next-line react-refresh/only-export-components
export function useBlendSpaceDocument() {
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  const { applyAssetDocumentChange } = useDocumentActions();
  const content = doc?.content;
  const payload = useMemo(() => normalizeBlendSpacePayload(asRecord(content)), [content]);
  const commit = useCallback(
    (next: BlendSpacePayload, mergeKey?: string) => {
      void applyAssetDocumentChange(documentId, { ...asRecord(content), ...next }, mergeKey);
    },
    [applyAssetDocumentChange, content, documentId],
  );
  return { payload, commit, documentId };
}

/** Animations a Blend Space can place: those on its Skeleton (none: those with no Skeleton). */
function useSkeletonAnimations(skeletonGuid: string | null) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? [])
      .filter((asset) => asset.header.type === "Animation" &&
        normalizeAnimationPayload(asset.header.payload ?? {}).skeletonGuid === skeletonGuid)
      .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [assetRegistry, registryEpoch, skeletonGuid]);
}

function formatAxisValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const PAD = { left: 48, right: 20, top: 20, bottom: 44 };

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

type GridDrag =
  | { kind: "sample"; index: number; pointerId: number; mergeKey: string }
  | { kind: "point"; pointerId: number }
  | { kind: "tap"; pointerId: number; startX: number; startY: number };

/**
 * The Blend Space Grid: its axes and grid lines, the samples as diamonds (drag to move them, snapped to the grid), the
 * triangulation of a two-axis space, and the preview point the Preview plays. Animations dropped here become samples.
 */
export function BlendSpaceGridPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, commit } = useBlendSpaceDocument();
  const { selectedSample, setSelectedSample, previewPoint, setPreviewPoint } = useBlendSpaceEditing();
  const { assetRegistry } = useRegistryState();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const dragRef = useRef<GridDrag | null>(null);
  const [xAxis, yAxis] = payload.axes;
  const point = blendSpacePreviewPoint(payload, previewPoint);
  const plotWidth = Math.max(1, size.width - PAD.left - PAD.right);
  const plotHeight = Math.max(1, size.height - PAD.top - PAD.bottom);
  const toScreen = (x: number, y: number) => ({
    sx: PAD.left + ((x - xAxis.min) / (xAxis.max - xAxis.min)) * plotWidth,
    sy: yAxis ? PAD.top + (1 - (y - yAxis.min) / (yAxis.max - yAxis.min)) * plotHeight : PAD.top + plotHeight / 2,
  });
  /** The axes' position under a client point, clamped to the axes; null for a point with no coordinates. */
  const fromClient = (clientX: number, clientY: number) => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = ref.current?.getBoundingClientRect();
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    const x = xAxis.min + ((sx - PAD.left) / plotWidth) * (xAxis.max - xAxis.min);
    const y = yAxis ? yAxis.min + (1 - (sy - PAD.top) / plotHeight) * (yAxis.max - yAxis.min) : 0;
    return {
      x: Math.min(xAxis.max, Math.max(xAxis.min, x)),
      y: yAxis ? Math.min(yAxis.max, Math.max(yAxis.min, y)) : 0,
    };
  };
  const layout = useMemo(() => blendSpaceLayoutOf(payload), [payload]);
  const triangles = useMemo(() => blendSpaceTriangles(layout), [layout]);
  const weights = useMemo(() => blendSpaceWeights(layout, point, triangles), [layout, point, triangles]);
  const nameOf = (guid: string) => assetRegistry?.getByGuid(guid)?.header.name ?? guid;
  const heaviest = payload.samples
    .map((sample, index) => ({ name: nameOf(sample.animationGuid), weight: weights[index] ?? 0 }))
    .filter((entry) => entry.weight > 0.005)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);

  const onBackgroundDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.focus();
    setSelectedSample(null);
    if (event.pointerType === "touch") {
      // On touch, a tap places the point; a drag from the point moves it.
      dragRef.current = { kind: "tap", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { kind: "point", pointerId: event.pointerId };
    const at = fromClient(event.clientX, event.clientY);
    if (at) setPreviewPoint(at);
  };
  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const at = fromClient(event.clientX, event.clientY);
    if (!at) return;
    if (drag.kind === "point") {
      setPreviewPoint(at);
    } else if (drag.kind === "sample") {
      const next = moveBlendSpaceSample(payload, drag.index, at);
      if (next !== payload) commit(next, drag.mergeKey);
    }
  };
  const onUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const at = fromClient(event.clientX, event.clientY);
    if (drag.kind === "tap" && at && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) {
      setPreviewPoint(at);
    }
    dragRef.current = null;
  };

  const xTicks = Array.from({ length: xAxis.gridDivisions + 1 }, (_, i) => xAxis.min + ((xAxis.max - xAxis.min) * i) / xAxis.gridDivisions);
  const yTicks = yAxis
    ? Array.from({ length: yAxis.gridDivisions + 1 }, (_, i) => yAxis.min + ((yAxis.max - yAxis.min) * i) / yAxis.gridDivisions)
    : [];
  const cross = toScreen(point.x, point.y);

  return (
    <PanelFrame data-testid="blend-space-grid-panel">
      <div
        ref={ref}
        className="relative h-full min-h-0 w-full bg-sidebar"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(BLEND_SPACE_ANIMATION_DRAG)) event.preventDefault();
        }}
        onDrop={(event) => {
          const guid = event.dataTransfer.getData(BLEND_SPACE_ANIMATION_DRAG);
          const at = fromClient(event.clientX, event.clientY);
          if (!guid || !at) return;
          event.preventDefault();
          commit(addBlendSpaceSample(payload, guid, at));
          setSelectedSample(payload.samples.length);
        }}
      >
        {size.width > 0 ? (
          <svg
            className="absolute inset-0 touch-none outline-none"
            width={size.width}
            height={size.height}
            tabIndex={0}
            role="application"
            aria-label="Blend Space Grid"
            data-testid="blend-space-grid"
            data-axes={payload.axes.length}
            data-point-x={formatAxisValue(point.x)}
            data-point-y={formatAxisValue(point.y)}
            onPointerDown={onBackgroundDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
            onKeyDown={(event) => {
              if (selectedSample === null) return;
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                commit(removeBlendSpaceSample(payload, selectedSample));
                setSelectedSample(null);
              }
            }}
          >
            {/* Grid lines and axis values. */}
            {xTicks.map((value, i) => {
              const { sx } = toScreen(value, yAxis?.min ?? 0);
              return (
                <g key={`x${i}`}>
                  <line x1={sx} x2={sx} y1={PAD.top} y2={PAD.top + plotHeight} stroke="var(--border)" strokeWidth={1} />
                  {i === 0 || i === xTicks.length - 1 || xTicks.length <= 9 ? (
                    <text x={sx} y={PAD.top + plotHeight + 14} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                      {formatAxisValue(value)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {yAxis
              ? yTicks.map((value, i) => {
                  const { sy } = toScreen(xAxis.min, value);
                  return (
                    <g key={`y${i}`}>
                      <line x1={PAD.left} x2={PAD.left + plotWidth} y1={sy} y2={sy} stroke="var(--border)" strokeWidth={1} />
                      {i === 0 || i === yTicks.length - 1 || yTicks.length <= 9 ? (
                        <text x={PAD.left - 6} y={sy + 3} textAnchor="end" fontSize={10} fill="var(--muted-foreground)">
                          {formatAxisValue(value)}
                        </text>
                      ) : null}
                    </g>
                  );
                })
              : (
                  <line x1={PAD.left} x2={PAD.left + plotWidth} y1={PAD.top + plotHeight / 2} y2={PAD.top + plotHeight / 2} stroke="var(--border)" strokeWidth={1} />
                )}
            <text x={PAD.left + plotWidth / 2} y={PAD.top + plotHeight + 32} textAnchor="middle" fontSize={11} fill="var(--foreground)">
              {`X · ${xAxis.name}${xAxis.wrap ? " (wraps)" : ""}`}
            </text>
            {yAxis ? (
              <text
                x={12}
                y={PAD.top + plotHeight / 2}
                textAnchor="middle"
                fontSize={11}
                fill="var(--foreground)"
                transform={`rotate(-90 12 ${PAD.top + plotHeight / 2})`}
              >
                {`Y · ${yAxis.name}${yAxis.wrap ? " (wraps)" : ""}`}
              </text>
            ) : null}
            {/* The triangulation the weights come from. */}
            {triangles.map(([a, b, c], i) => {
              const pa = toScreen(payload.samples[a]!.x, payload.samples[a]!.y);
              const pb = toScreen(payload.samples[b]!.x, payload.samples[b]!.y);
              const pc = toScreen(payload.samples[c]!.x, payload.samples[c]!.y);
              return (
                <polygon
                  key={`t${i}`}
                  points={`${pa.sx},${pa.sy} ${pb.sx},${pb.sy} ${pc.sx},${pc.sy}`}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeOpacity={0.45}
                  strokeWidth={1}
                  pointerEvents="none"
                />
              );
            })}
            {payload.samples.map((sample, index) => {
              const { sx, sy } = toScreen(sample.x, sample.y);
              const selected = index === selectedSample;
              return (
                <g
                  key={index}
                  data-testid={`blend-space-sample-${index}`}
                  data-selected={selected ? "true" : "false"}
                  data-x={formatAxisValue(sample.x)}
                  data-y={formatAxisValue(sample.y)}
                  className="cursor-grab"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    (event.currentTarget.ownerSVGElement as SVGSVGElement | null)?.focus();
                    event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId);
                    setSelectedSample(index);
                    dragRef.current = { kind: "sample", index, pointerId: event.pointerId, mergeKey: `blend-space:sample:${index}:${event.timeStamp}` };
                  }}
                >
                  {/* A wider transparent target for touch. */}
                  <circle cx={sx} cy={sy} r={16} fill="transparent" />
                  <rect
                    x={sx - 6}
                    y={sy - 6}
                    width={12}
                    height={12}
                    transform={`rotate(45 ${sx} ${sy})`}
                    fill="var(--node-anim-pose)"
                    stroke={selected ? "var(--graph-state-selected)" : "var(--background)"}
                    strokeWidth={selected ? 2.5 : 1.5}
                  />
                  <text x={sx + 10} y={sy - 8} fontSize={10} fill="var(--foreground)" pointerEvents="none">
                    {nameOf(sample.animationGuid)}
                  </text>
                </g>
              );
            })}
            {/* The preview point. */}
            <g
              data-testid="blend-space-preview-point"
              className="cursor-move"
              onPointerDown={(event) => {
                event.stopPropagation();
                event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId);
                dragRef.current = { kind: "point", pointerId: event.pointerId };
              }}
            >
              <circle cx={cross.sx} cy={cross.sy} r={14} fill="transparent" />
              <line x1={cross.sx - 7} x2={cross.sx + 7} y1={cross.sy - 7} y2={cross.sy + 7} stroke="var(--destructive)" strokeWidth={2} />
              <line x1={cross.sx - 7} x2={cross.sx + 7} y1={cross.sy + 7} y2={cross.sy - 7} stroke="var(--destructive)" strokeWidth={2} />
            </g>
          </svg>
        ) : null}
        <div
          className="pointer-events-none absolute right-2 top-2 flex flex-col gap-0.5 rounded-md bg-background/85 px-2 py-1 text-xs tabular-nums"
          data-testid="blend-space-weights"
        >
          <span className="text-muted-foreground">
            {yAxis ? `X ${formatAxisValue(point.x)} · Y ${formatAxisValue(point.y)}` : `X ${formatAxisValue(point.x)}`}
          </span>
          {heaviest.map((entry) => (
            <span key={entry.name} className="flex justify-between gap-3">
              <span className="truncate">{entry.name}</span>
              <span>{entry.weight.toFixed(2)}</span>
            </span>
          ))}
        </div>
        {payload.samples.length === 0 ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-14 text-center text-xs text-muted-foreground">
            Drag an Animation here, or add one from Animations.
          </p>
        ) : null}
      </div>
    </PanelFrame>
  );
}

/** Animations on the Blend Space's Skeleton: drag one onto the Grid, or add it at the preview point. */
export function BlendSpaceAnimationsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, commit } = useBlendSpaceDocument();
  const { previewPoint, setSelectedSample } = useBlendSpaceEditing();
  const animations = useSkeletonAnimations(payload.skeletonGuid);
  const point = blendSpacePreviewPoint(payload, previewPoint);
  return (
    <PanelFrame data-testid="blend-space-animations-panel">
      {animations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Animations</EmptyTitle>
            <EmptyDescription>
              {payload.skeletonGuid ? "No Animation is on this Blend Space's Skeleton." : "Pick the Blend Space's Skeleton in the Inspector."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-0.5 p-2" role="list" aria-label="Animations">
          {animations.map((animation) => {
            const placed = payload.samples.filter((sample) => sample.animationGuid === animation.guid).length;
            return (
              <div
                key={animation.guid}
                role="listitem"
                draggable
                className="flex min-h-[var(--chrome-row,28px)] cursor-grab items-center gap-1 rounded-md px-1 text-sm hover:bg-accent"
                data-testid={`blend-space-animation-${animation.guid}`}
                onDragStart={(event) => {
                  event.dataTransfer.setData(BLEND_SPACE_ANIMATION_DRAG, animation.guid);
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="min-w-0 flex-1 truncate">{animation.name}</span>
                {placed > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{placed}</span> : null}
                <IconActionButton
                  label="Add At Preview Point"
                  variant="ghost"
                  data-testid={`blend-space-add-${animation.guid}`}
                  onClick={() => {
                    commit(addBlendSpaceSample(payload, animation.guid, point));
                    setSelectedSample(payload.samples.length);
                  }}
                >
                  <PlusIcon />
                </IconActionButton>
              </div>
            );
          })}
        </div>
      )}
    </PanelFrame>
  );
}

function axisRows(
  axis: BlendSpaceAxisPayload,
  index: 0 | 1,
  payload: BlendSpacePayload,
  commit: (next: BlendSpacePayload, mergeKey?: string) => void,
): PropertyRow[] {
  const prefix = index === 0 ? "x" : "y";
  const patch = (field: keyof BlendSpaceAxisPayload) => (value: string | number | boolean) =>
    commit(patchBlendSpaceAxis(payload, index, { [field]: value }), `blend-space:axis:${index}:${field}`);
  return [
    { kind: "text", id: `${prefix}-name`, label: "Name", value: axis.name, onChange: (value) => patch("name")(value.trim() || axis.name) },
    { kind: "number", id: `${prefix}-min`, label: "Minimum", value: axis.min, max: axis.max, onChange: patch("min") },
    { kind: "number", id: `${prefix}-max`, label: "Maximum", value: axis.max, min: axis.min, onChange: patch("max") },
    { kind: "number", id: `${prefix}-divisions`, label: "Grid Divisions", value: axis.gridDivisions, min: 1, max: 64, precision: 0, onChange: patch("gridDivisions") },
    {
      kind: "number",
      id: `${prefix}-smoothing`,
      label: "Smoothing Time",
      unit: "s",
      value: axis.smoothingSeconds,
      min: 0,
      description: "How long a change of this input takes to settle. 0 follows it at once.",
      onChange: patch("smoothingSeconds"),
    },
    {
      kind: "boolean",
      id: `${prefix}-wrap`,
      label: "Wrap",
      value: axis.wrap,
      description: "Joins the ends, so an input past one comes in at the other, as for an angle.",
      onChange: patch("wrap"),
    },
  ];
}

/** The Blend Space's Skeleton and axes, and the selected sample. */
export function BlendSpaceDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, commit } = useBlendSpaceDocument();
  const { selectedSample, setSelectedSample } = useBlendSpaceEditing();
  const { assetRegistry } = useRegistryState();
  const animations = useSkeletonAnimations(payload.skeletonGuid);
  const [skeletonPick, setSkeletonPick] = useState(false);
  const [samplePick, setSamplePick] = useState(false);
  const skeletons = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "Skeleton")
    .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));
  const skeleton = payload.skeletonGuid ? assetRegistry?.getByGuid(payload.skeletonGuid) : undefined;
  const sample = selectedSample === null ? undefined : payload.samples[selectedSample];
  const sampleAsset = sample ? assetRegistry?.getByGuid(sample.animationGuid) : undefined;
  const [xAxis, yAxis] = payload.axes;
  const sampleRows: PropertyRow[] = sample && selectedSample !== null
    ? [
        {
          kind: "asset",
          id: "sample-animation",
          label: "Animation",
          value: sample.animationGuid,
          placeholder: "None",
          assetTypes: ["Animation"],
          onPick: () => setSamplePick(true),
          onChange: (value) => {
            if (value) commit(patchBlendSpaceSample(payload, selectedSample, { animationGuid: value }));
          },
          ...assetRowIdentity(sampleAsset ? { name: sampleAsset.header.name, type: "Animation" } : { name: sample.animationGuid, type: "Animation" }),
        },
        {
          kind: "number",
          id: "sample-x",
          label: xAxis.name,
          value: sample.x,
          min: xAxis.min,
          max: xAxis.max,
          onChange: (x) => commit(patchBlendSpaceSample(payload, selectedSample, { x: snapToBlendSpaceGrid(xAxis, x) }), `blend-space:sample:${selectedSample}:x`),
        },
        ...(yAxis
          ? [{
              kind: "number" as const,
              id: "sample-y",
              label: yAxis.name,
              value: sample.y,
              min: yAxis.min,
              max: yAxis.max,
              onChange: (y: number) => commit(patchBlendSpaceSample(payload, selectedSample, { y: snapToBlendSpaceGrid(yAxis, y) }), `blend-space:sample:${selectedSample}:y`),
            }]
          : []),
        {
          kind: "number",
          id: "sample-rate",
          label: "Rate Scale",
          value: sample.rateScale,
          defaultValue: 1,
          min: 0.01,
          description: "Plays this sample faster or slower; 1 plays it at its Animation's Duration.",
          onChange: (rateScale) => commit(patchBlendSpaceSample(payload, selectedSample, { rateScale: Math.max(0.01, rateScale) }), `blend-space:sample:${selectedSample}:rate`),
        },
      ]
    : [];
  return (
    <PanelFrame data-testid="blend-space-details-panel">
      <div className="flex flex-col gap-2 py-2">
        <PropertyGrid
          rows={[{
            kind: "asset",
            id: "skeleton",
            label: "Skeleton",
            value: payload.skeletonGuid,
            placeholder: "None",
            assetTypes: ["Skeleton"],
            onPick: () => setSkeletonPick(true),
            onChange: (value) => commit({ ...payload, skeletonGuid: value || null }),
            ...assetRowIdentity(skeleton ? { name: skeleton.header.name, type: "Skeleton" } : undefined),
          }]}
        />
        <div className="flex items-center justify-between gap-2 px-3">
          <span className="text-sm">Axes</span>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[String(payload.axes.length)]}
            aria-label="Axes"
            data-testid="blend-space-axis-count"
            onValueChange={(value) => {
              const count = value[0] === "2" ? 2 : value[0] === "1" ? 1 : null;
              if (count) commit(setBlendSpaceAxisCount(payload, count));
            }}
          >
            <ToggleGroupItem value="1" data-testid="blend-space-axes-one">One</ToggleGroupItem>
            <ToggleGroupItem value="2" data-testid="blend-space-axes-two">Two</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <PropertySectionTitle>Horizontal Axis</PropertySectionTitle>
        <PropertyGrid rows={axisRows(xAxis, 0, payload, commit)} data-testid="blend-space-x-axis" />
        {yAxis ? (
          <>
            <PropertySectionTitle>Vertical Axis</PropertySectionTitle>
            <PropertyGrid rows={axisRows(yAxis, 1, payload, commit)} data-testid="blend-space-y-axis" />
          </>
        ) : null}
        <PropertySectionTitle>Sample</PropertySectionTitle>
        {sample && selectedSample !== null ? (
          <>
            <PropertyGrid rows={sampleRows} data-testid="blend-space-sample" />
            <div className="flex px-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="blend-space-remove-sample"
                onClick={() => {
                  commit(removeBlendSpaceSample(payload, selectedSample));
                  setSelectedSample(null);
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Remove Sample
              </Button>
            </div>
          </>
        ) : (
          <p className="px-3 text-sm text-muted-foreground" data-testid="blend-space-no-sample">
            Select a sample on the Grid.
          </p>
        )}
      </div>
      <AssetPicker
        open={skeletonPick}
        onOpenChange={setSkeletonPick}
        assets={skeletons}
        allowedTypes={["Skeleton"]}
        title="Pick Skeleton"
        allowNone
        onPick={(guid) => {
          commit({ ...payload, skeletonGuid: guid || null });
          setSkeletonPick(false);
        }}
        data-testid="blend-space-skeleton-picker"
      />
      <AssetPicker
        open={samplePick}
        onOpenChange={setSamplePick}
        assets={animations}
        allowedTypes={["Animation"]}
        title="Pick Animation"
        allowNone={false}
        onPick={(guid) => {
          if (guid && selectedSample !== null) commit(patchBlendSpaceSample(payload, selectedSample, { animationGuid: guid }));
          setSamplePick(false);
        }}
        data-testid="blend-space-sample-picker"
      />
    </PanelFrame>
  );
}
