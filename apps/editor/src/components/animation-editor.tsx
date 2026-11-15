import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
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
  type AnimationAdditive,
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
import { Button } from "@haptic/ui/components/button";
import { Toggle } from "@haptic/ui/components/toggle";
import { PauseIcon, PlayIcon, RepeatIcon, RotateCcwIcon, StepForwardIcon } from "lucide-react";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalAnimationEditing } from "../context/animation-editing-context";
import { AnimationEventsEditor } from "./animation-events-editor";

import { AnimEventFlashes } from "./anim-event-flashes";
import { useClockEventFlashes } from "../lib/anim-event-flashes";
import { AnimationPreviewCanvas, type AnimationPreviewClip } from "./animation-preview-canvas";
import { IconActionButton } from "./icon-action-button";
import { PlaybackScrubber, PlaybackSpeedSelect } from "./playback-controls";
import { ModelSourceReadError } from "./model-editor";
import { asRecord } from "../lib/as-record";
import { AnimationPreviewClock, animationPreviewFrameAt } from "../lib/animation-preview-clock";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";
import { useModelSourceBytes } from "../lib/use-model-source-bytes";

/** A Skeleton asset's bone and socket names, for the Spawn Particle System Bone row. */
function skeletonAttachPointLists(payload: unknown): { bones: string[]; sockets: string[] } {
  const skeleton = normalizeSkeletonPayload(payload ?? {});
  return { bones: skeleton.bones.map((bone) => bone.name), sockets: skeleton.sockets.map((socket) => socket.name) };
}

export function AnimationPreviewPanel(props: IDockviewPanelProps) {
  const shown = useDockPanelShown(props.api);
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
        active={shown}
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

/** Preview time for a clip whose length is not known yet. */
const UNKNOWN_DURATION_MS = 1000;

/** One pass of the clip in the preview: the authored Duration, else the clip's length in its file. */
function previewDurationMs(payload: AnimationPayload, clip: AnimationPreviewClip | null): number {
  return payload.durationMs ?? payload.clipDurationMs ?? clip?.durationMs ?? UNKNOWN_DURATION_MS;
}

/** Advances the clock by real time on each frame while the preview is shown and playing. */
function usePreviewPlayback(clock: AnimationPreviewClock, active: boolean) {
  const { playing } = useSyncExternalStore(clock.subscribe, clock.getPlayback, clock.getPlayback);
  useEffect(() => {
    if (!active || !playing) return;
    let last = performance.now();
    let id = 0;
    const frame = (now: number) => {
      clock.advance(now - last);
      last = now;
      id = window.requestAnimationFrame(frame);
    };
    id = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(id);
  }, [active, clock, playing]);
}

/** Play or Pause, Step, Restart, Loop and Speed for the Animation preview. */
function AnimationPreviewTransport({
  clock,
  frameMs,
  children,
}: {
  clock: AnimationPreviewClock;
  frameMs: number;
  children?: ReactNode;
}) {
  const playback = useSyncExternalStore(clock.subscribe, clock.getPlayback, clock.getPlayback);
  return (
    <ToolbarStrip className="shrink-0 flex-wrap gap-1 py-1" data-testid="animation-preview-toolbar">
      <Button
        type="button"
        size="sm"
        variant={playback.playing ? "secondary" : "default"}
        data-testid={playback.playing ? "animation-preview-pause" : "animation-preview-play"}
        onClick={() => clock.setPlaying(!playback.playing)}
      >
        {playback.playing ? <PauseIcon fill="currentColor" /> : <PlayIcon fill="currentColor" />}
        {playback.playing ? "Pause" : "Play"}
      </Button>
      <IconActionButton label="Step" variant="ghost" data-testid="animation-preview-step" onClick={() => clock.step(frameMs)}>
        <StepForwardIcon />
      </IconActionButton>
      <IconActionButton label="Restart" variant="ghost" data-testid="animation-preview-restart" onClick={() => clock.restart()}>
        <RotateCcwIcon />
      </IconActionButton>
      <Toggle
        size="sm"
        variant="outline"
        pressed={playback.loop}
        aria-label="Loop"
        data-testid="animation-preview-loop"
        onPressedChange={(loop) => clock.setLoop(loop)}
      >
        <RepeatIcon />
        Loop
      </Toggle>
      <PlaybackSpeedSelect value={playback.speed} onChange={(speed) => clock.setSpeed(speed)} data-testid="animation-preview-speed" />
      {children}
    </ToolbarStrip>
  );
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
  active = true,
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
  /** Whether the preview is on screen; time advances only then. */
  active?: boolean;
}) {
  // A Model with nothing to draw (an animation library) always shows its bones.
  const [bonesOnly, setBonesOnly] = useState(false);
  const [clip, setClip] = useState<AnimationPreviewClip | null>(null);
  const durationMs = previewDurationMs(payload, clip);
  // In the Animation editor the Timeline scrubs this clock too.
  const editing = useOptionalAnimationEditing();
  const [ownClock] = useState(() => new AnimationPreviewClock(durationMs));
  const clock = editing?.clock ?? ownClock;
  useEffect(() => clock.setDuration(durationMs), [clock, durationMs]);
  usePreviewPlayback(clock, active);
  // The clip's Animation Events flash their names as playback passes them.
  const flashes = useClockEventFlashes(clock, payload.events ?? [], durationMs);
  const frameCount = clip?.frames ?? 1;
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
      <AnimationPreviewTransport clock={clock} frameMs={durationMs / frameCount}>
        <Toggle
          size="sm"
          variant="outline"
          className="ml-auto"
          pressed={showBones || bonesOnly}
          disabled={bonesOnly}
          aria-label="Show Bones"
          data-testid="animation-show-bones"
          onPressedChange={(pressed) => onShowBonesChange?.(pressed)}
        >
          Show Bones
        </Toggle>
      </AnimationPreviewTransport>
      <div className="relative min-h-0 flex-1">
        <AnimEventFlashes flashes={flashes} data-testid="animation-preview-events" />
        <AnimationPreviewCanvas
          sourceBytes={sourceBytes}
          materialSlots={materialSlots}
          clipName={payload.clipName}
          clock={clock}
          skeletonKind={skeletonKind}
          showBones={showBones}
          onBonesOnlyChange={setBonesOnly}
          onClip={setClip}
          sourceClipBytes={
            payload.sourceAnimationGuid ? sourceClipBytes : null
          }
        />
      </div>
      <div className="flex shrink-0 min-w-0 items-center gap-3 border-t border-border bg-panel-header px-2 py-2">
        <PlaybackScrubber
          time={clock}
          durationMs={durationMs}
          frameCount={frameCount}
          frameAt={(timeMs) => animationPreviewFrameAt(timeMs, durationMs, frameCount)}
          onSeek={(timeMs) => clock.seek(timeMs)}
          testIdPrefix="animation-preview"
        />
      </div>
    </div>
  );
}

/** What an Animation's Additive row offers: not additive, or a change relative to one of its base poses. */
const ADDITIVE_OPTIONS: Array<{ value: AnimationAdditive["base"] | "none"; label: string }> = [
  { value: "none", label: "None" },
  { value: "restPose", label: "Relative To Rest Pose" },
  { value: "firstFrame", label: "Relative To First Frame" },
  { value: "animation", label: "Relative To Animation" },
];

/**
 * An Animation's Additive rows: whether it is additive and its base pose, with the base Animation (one on its
 * Skeleton) and the time in it when that is the base.
 */
function additiveRows(
  animation: AnimationPayload,
  assets: ReadonlyArray<{ header: { guid: string; name: string; type: string } }>,
  onAdditive: ((additive: AnimationAdditive | undefined, mergeKey?: string) => void) | undefined,
  onPickBase: () => void,
): PropertyRow[] {
  const additive = animation.additive;
  const rows: PropertyRow[] = [{
    id: "additive",
    kind: "enum",
    label: "Additive",
    value: additive?.base ?? "none",
    defaultValue: "none",
    options: ADDITIVE_OPTIONS,
    verbatim: true,
    disabled: !onAdditive,
    onChange: (base) => onAdditive?.(
      base === "none" ? undefined : base === "animation" ? { base, timeMs: 0 } : { base: base as AnimationAdditive["base"] },
    ),
  }];
  if (additive?.base !== "animation") return rows;
  const baseAnimation = assets.find((asset) => asset.header.guid === additive.animationGuid);
  rows.push(
    {
      id: "additiveAnimation",
      kind: "asset",
      label: "Base Animation",
      value: additive.animationGuid ?? null,
      placeholder: "None",
      assetTypes: ["Animation"],
      disabled: !onAdditive,
      onPick: onPickBase,
      onChange: (guid) => onAdditive?.({ ...additive, ...(guid ? { animationGuid: guid } : { animationGuid: undefined }) }),
      ...assetRowIdentity(baseAnimation ? { name: baseAnimation.header.name, type: "Animation" } : undefined),
    },
    {
      id: "additiveTimeMs",
      kind: "number",
      label: "Base Time",
      unit: "ms",
      min: 0,
      value: additive.timeMs ?? 0,
      defaultValue: 0,
      disabled: !onAdditive,
      onChange: (timeMs) => onAdditive?.({ ...additive, timeMs: Math.max(0, timeMs) }, "animation:additiveTimeMs"),
    },
  );
  return rows;
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
  const [pickingBase, setPickingBase] = useState(false);
  // In the Animation editor, events selected on the Timeline open here and Add Event uses its playhead.
  const editing = useOptionalAnimationEditing();
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
  const setAdditive = onChange
    ? (additive: AnimationAdditive | undefined, mergeKey?: string) => {
        const { additive: _previous, ...rest } = { ...payload, ...animation };
        void _previous;
        onChange(additive ? { ...rest, additive } : rest, mergeKey);
      }
    : undefined;
  rows.push(...additiveRows(animation, assets, setAdditive, () => setPickingBase(true)));
  // A base Animation is another Animation on this one's Skeleton.
  const baseAssets = pickingBase
    ? assets
        .filter((asset) => asset.header.type === "Animation" &&
          normalizeAnimationPayload(asset.header.payload ?? {}).skeletonGuid === animation.skeletonGuid)
        .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))
    : [];
  return (
    <div data-testid="animation-editor">
      <PropertyGrid rows={rows} />
      <AssetPicker
        open={pickingBase}
        onOpenChange={setPickingBase}
        assets={baseAssets}
        allowedTypes={["Animation"]}
        title="Pick Base Animation"
        allowNone
        onPick={(guid) => {
          if (animation.additive?.base === "animation") {
            setAdditive?.({ ...animation.additive, ...(guid ? { animationGuid: guid } : { animationGuid: undefined }) });
          }
          setPickingBase(false);
        }}
        data-testid="animation-additive-base-picker"
      />
      <AnimationEventsEditor
        events={animation.events ?? []}
        timed
        bones
        attachPoints={skeleton ? skeletonAttachPointLists(skeleton.header.payload) : undefined}
        newEventTimeMs={editing?.clock.get() ?? 0}
        selectedIds={editing?.selectedEventIds}
        mergeKeyPrefix="animation:event"
        onChange={
          onChange
            ? (events, mergeKey) =>
                onChange(
                  { ...payload, ...animation, events: events.map((event) => ({ ...event, timeMs: event.timeMs ?? 0, durationMs: event.durationMs ?? 0 })) },
                  mergeKey,
                )
            : undefined
        }
        data-testid="animation-events"
      />
    </div>
  );
}
