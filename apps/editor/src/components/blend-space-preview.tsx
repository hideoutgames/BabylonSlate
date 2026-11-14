import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { AnimGraphDimension } from "@haptic/anim-graph";
import { normalizeSpriteBlendSpacePayload } from "@haptic/assets";
import { PanelFrame, ToolbarStrip } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useRegistryState } from "../context/document-context";
import { useBlendSpaceEditing } from "../context/blend-space-editing-context";
import { blendSpaceNodeDataOf, blendSpacePreviewPoint, spriteBlendSpaceNodeDataOf } from "../lib/blend-space-editing";
import { BlendSpacePreviewSession } from "../lib/blend-space-preview-session";
import { useAnimPreviewModel } from "../lib/use-anim-preview-model";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";
import { AnimPreview3DView, AnimPreviewModelControls } from "./anim-preview-model-controls";
import { AnimSpriteFrameView } from "./anim-sprite-frame-view";
import { useBlendSpaceDocument, type BlendSpaceEditorPayload } from "./blend-space-editor";
import { PlaybackSpeedSelect } from "./playback-controls";

/** Play or Pause and Speed, with the cycle's position, which changes every frame. */
function BlendSpacePreviewTransport({ session, children }: { session: BlendSpacePreviewSession; children?: ReactNode }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return (
    <ToolbarStrip className="shrink-0 flex-wrap gap-1 py-1" data-testid="blend-space-preview-transport">
      <Button
        type="button"
        size="sm"
        variant={snapshot.playing ? "secondary" : "default"}
        data-testid={snapshot.playing ? "blend-space-preview-pause" : "blend-space-preview-play"}
        onClick={() => session.setPlaying(!snapshot.playing)}
      >
        {snapshot.playing ? <PauseIcon fill="currentColor" /> : <PlayIcon fill="currentColor" />}
        {snapshot.playing ? "Pause" : "Play"}
      </Button>
      <PlaybackSpeedSelect value={snapshot.speed} onChange={(speed) => session.setSpeed(speed)} data-testid="blend-space-preview-speed" />
      {children}
      <span className="ml-auto min-w-0 truncate px-1 text-xs tabular-nums text-muted-foreground" data-testid="blend-space-preview-cycle">
        {snapshot.state ? `${snapshot.state.normalisedTime.toFixed(2)} · ${snapshot.state.facts.durationSeconds.toFixed(2)} s` : ""}
      </span>
    </ToolbarStrip>
  );
}

/** The Sprite Blend Space's frame, which changes every frame it plays. */
function SpriteFrame({ session }: { session: BlendSpacePreviewSession }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <AnimSpriteFrameView state={snapshot.state} data-testid="blend-space-preview-2d" />;
}

/** Feeds the session the document's samples and the Grid's preview point, and real time while the window shows. */
function usePreviewSession(dimension: AnimGraphDimension, payload: BlendSpaceEditorPayload, api: IDockviewPanelProps["api"]) {
  const { previewPoint } = useBlendSpaceEditing();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const shown = useDockPanelShown(api);
  const [session] = useState(() => new BlendSpacePreviewSession(dimension));
  const nodeData = useMemo(() => {
    void registryEpoch;
    const lookup = (type: string) => (guid: string) => {
      const asset = assetRegistry?.getByGuid(guid);
      return asset?.header.type === type ? { payload: asset.header.payload } : undefined;
    };
    return dimension === "2d"
      ? spriteBlendSpaceNodeDataOf(normalizeSpriteBlendSpacePayload(payload), lookup("SpriteAnimation"))
      : blendSpaceNodeDataOf(payload, lookup("Animation"));
  }, [assetRegistry, dimension, payload, registryEpoch]);
  const point = blendSpacePreviewPoint(payload, previewPoint);
  useEffect(() => session.setBlendSpace(nodeData), [nodeData, session]);
  useEffect(() => session.setPoint({ x: point.x, y: point.y }), [point.x, point.y, session]);
  useEffect(() => {
    if (!shown) return;
    let last = performance.now();
    let id = 0;
    const frame = (now: number) => {
      session.advanceRealTime((now - last) / 1000);
      last = now;
      id = window.requestAnimationFrame(frame);
    };
    id = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(id);
  }, [session, shown]);
  return session;
}

function BlendSpacePreview3D({ api }: { api: IDockviewPanelProps["api"] }) {
  const { payload, commit } = useBlendSpaceDocument();
  const session = usePreviewSession("3d", payload, api);
  const [showBones, setShowBones] = useState(false);
  const animationGuids = useMemo(() => [...new Set(payload.samples.map((sample) => sample.animationGuid))], [payload.samples]);
  const preview = useAnimPreviewModel({
    skeletonGuid: payload.skeletonGuid ?? null,
    animationGuids,
    previewModelGuid: payload.previewModelGuid ?? null,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BlendSpacePreviewTransport session={session}>
        <AnimPreviewModelControls
          preview={preview}
          onModelChange={(previewModelGuid) => commit({ ...payload, previewModelGuid })}
          showBones={showBones}
          onShowBonesChange={setShowBones}
          testIdPrefix="blend-space-preview"
        />
      </BlendSpacePreviewTransport>
      <AnimPreview3DView
        preview={preview}
        showBones={showBones}
        getState={session.getState}
        subscribe={session.subscribe}
        emptyText={payload.skeletonGuid ? "No Model is on the Blend Space's Skeleton." : "Set the Blend Space's Skeleton to preview it."}
        data-testid="blend-space-preview-3d"
      />
    </div>
  );
}

function BlendSpacePreview2D({ api }: { api: IDockviewPanelProps["api"] }) {
  const { payload } = useBlendSpaceDocument();
  const session = usePreviewSession("2d", payload, api);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BlendSpacePreviewTransport session={session} />
      <SpriteFrame session={session} />
    </div>
  );
}

/**
 * A Blend Space's Preview: the blend at the Grid's preview point through the game's evaluator, with Play, Pause and
 * Speed: a Model on the Skeleton (3D), or the nearest sample's frames (Sprite Blend Space). Time runs only while the
 * window shows.
 */
export function BlendSpacePreviewPanel(props: IDockviewPanelProps) {
  const { dimension } = useBlendSpaceDocument();
  return (
    <PanelFrame data-testid="blend-space-preview-panel">
      {dimension === "2d" ? <BlendSpacePreview2D api={props.api} /> : <BlendSpacePreview3D api={props.api} />}
    </PanelFrame>
  );
}
