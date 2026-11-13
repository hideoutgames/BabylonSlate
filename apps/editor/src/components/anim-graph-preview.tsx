import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ANIM_POSE_BLEND_SPACE_PLAYER_TYPE,
  blendSpaceNodeData,
  isPoseClipNodeType,
  type AnimClipLayer,
  type AnimGraphDocument,
  type AnimGraphVariable,
} from "@haptic/anim-graph";
import { parseSpriteAnimationPayload, spriteAnimationDurationMs, spriteAnimationPlayhead } from "@haptic/assets";
import { PanelFrame, PropertyGrid, ToolbarStrip, type PropertyRow } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { PauseIcon, PlayIcon, RotateCcwIcon, StepForwardIcon } from "lucide-react";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { useAnimGraphPreview } from "../context/anim-graph-preview-context";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";
import { useAnimPreviewModel } from "../lib/use-anim-preview-model";
import { variableDefaultPropertyRows } from "../lib/graph-inspector";
import { useAnimGraphDocument } from "./anim-graph-editor";
import { AnimPreview3DView, AnimPreviewModelControls } from "./anim-preview-model-controls";
import { IconActionButton } from "./icon-action-button";
import { PlaybackSpeedSelect } from "./playback-controls";
import { useResolvedSpriteAnimation } from "./sprite-animation-sources";
import { CHECKERBOARD, FrameImage } from "./sprite-frame-image";
import { useTexturePreviews } from "./texture-preview-status";

/** Waits this long after an edit before compiling the graph's rules again. */
const RECOMPILE_DELAY_MS = 300;

/** The Animation assets the graph's state graphs play (players, Sequence Evaluators and Blend Space samples), in first-use order. */
function graphAnimationGuids(doc: AnimGraphDocument): string[] {
  const guids = new Set<string>();
  for (const state of doc.stateMachine.states) {
    for (const node of state.stateGraph.nodes) {
      if (node.type === ANIM_POSE_BLEND_SPACE_PLAYER_TYPE) {
        for (const sample of blendSpaceNodeData(node).samples) guids.add(sample.animationGuid);
        continue;
      }
      const guid = node.data.assetGuid;
      if (isPoseClipNodeType(node.type) && typeof guid === "string" && guid) guids.add(guid);
    }
  }
  return [...guids];
}

/**
 * Runs the open Animation Graph in the editor while the Preview window shows: keeps the session on the current
 * document, compiles its rules again shortly after each edit, and feeds it real time.
 */
function usePreviewClock(api: IDockviewPanelProps["api"]) {
  const { doc, graphGuid } = useAnimGraphDocument();
  const session = useAnimGraphPreview();
  const { collectPlayPreviewScripts } = useDocumentActions();
  const shown = useDockPanelShown(api);

  useEffect(() => {
    if (!graphGuid) return;
    session.setDocument(doc, graphGuid);
    if (!session.getSnapshot().state) session.tick(0);
  }, [doc, graphGuid, session]);

  useEffect(() => {
    if (!graphGuid) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void collectPlayPreviewScripts(new Set([graphGuid]))
        .then(async ({ bundles }) => {
          if (cancelled) return;
          await session.loadScripts(bundles);
        })
        .catch(() => {});
    }, RECOMPILE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [collectPlayPreviewScripts, doc, graphGuid, session]);

  useEffect(() => {
    session.setActive(shown);
    if (!shown) return;
    let last = performance.now();
    let id = 0;
    const frame = (now: number) => {
      session.advanceRealTime((now - last) / 1000);
      last = now;
      id = window.requestAnimationFrame(frame);
    };
    id = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(id);
      session.setActive(false);
    };
  }, [session, shown]);
}

function PreviewTransport({ extra }: { extra?: ReactNode }) {
  const { doc } = useAnimGraphDocument();
  const session = useAnimGraphPreview();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const state = snapshot.state;
  const stateName = state ? doc.stateMachine.states.find((row) => row.id === state.stateId)?.name ?? state.stateId : "";
  return (
    <ToolbarStrip className="shrink-0 flex-wrap gap-1 py-1" data-testid="anim-preview-transport">
      <Button
        type="button"
        size="sm"
        variant={snapshot.playing ? "secondary" : "default"}
        data-testid={snapshot.playing ? "anim-preview-pause" : "anim-preview-play"}
        onClick={() => session.setPlaying(!snapshot.playing)}
      >
        {snapshot.playing ? <PauseIcon fill="currentColor" /> : <PlayIcon fill="currentColor" />}
        {snapshot.playing ? "Pause" : "Play"}
      </Button>
      <IconActionButton label="Step" variant="ghost" data-testid="anim-preview-step" onClick={() => session.step()}>
        <StepForwardIcon />
      </IconActionButton>
      <IconActionButton label="Restart" variant="ghost" data-testid="anim-preview-restart" onClick={() => session.restart()}>
        <RotateCcwIcon />
      </IconActionButton>
      <PlaybackSpeedSelect value={snapshot.speed} onChange={(speed) => session.setSpeed(speed)} data-testid="anim-preview-speed" />
      {extra}
      <span className="ml-auto min-w-0 truncate px-1 text-xs text-muted-foreground tabular-nums" data-testid="anim-preview-state">
        {state ? `${stateName} · ${state.facts.elapsedSeconds.toFixed(2)} s` : ""}
      </span>
    </ToolbarStrip>
  );
}

function Preview3D({ api }: { api: IDockviewPanelProps["api"] }) {
  const { doc, commit } = useAnimGraphDocument();
  const session = useAnimGraphPreview();
  const animationGuids = useMemo(() => graphAnimationGuids(doc), [doc]);
  const preview = useAnimPreviewModel({ skeletonGuid: doc.skeletonGuid, animationGuids, previewModelGuid: doc.previewModelGuid });
  const [showBones, setShowBones] = useState(false);
  const getState = useCallback(() => session.getSnapshot().state, [session]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewTransport
        extra={
          <AnimPreviewModelControls
            preview={preview}
            onModelChange={(previewModelGuid) => commit({ ...doc, previewModelGuid })}
            showBones={showBones}
            onShowBonesChange={setShowBones}
            testIdPrefix="anim-preview"
          />
        }
      />
      <AnimPreview3DView
        preview={preview}
        showBones={showBones}
        getState={getState}
        subscribe={session.subscribe}
        emptyText={doc.skeletonGuid ? "No Model is on the graph's Skeleton." : "Set the graph's Skeleton to preview it."}
        data-testid="anim-preview-3d"
      />
      <PreviewClock api={api} />
    </div>
  );
}

/** The heaviest frame layer: frames never blend, so the Preview shows one, as Play does. */
function heaviestSpriteLayer(layers: readonly AnimClipLayer[]): AnimClipLayer | undefined {
  return layers
    .filter((layer) => layer.clipKind === "sprite")
    .reduce<AnimClipLayer | undefined>((best, layer) => (!best || layer.weight > best.weight ? layer : best), undefined);
}

function Preview2D({ api }: { api: IDockviewPanelProps["api"] }) {
  const session = useAnimGraphPreview();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { assetRegistry } = useRegistryState();
  const layer = snapshot.state ? heaviestSpriteLayer(snapshot.state.layers) : undefined;
  const asset = layer ? assetRegistry?.getByGuid(layer.clipAssetGuid) : undefined;
  const animation = useMemo(
    () => parseSpriteAnimationPayload(asset?.header.type === "SpriteAnimation" ? asset.header.payload : {}),
    [asset],
  );
  const { resolved, views } = useResolvedSpriteAnimation(animation);
  const index = layer && animation.frames.length > 0
    ? spriteAnimationPlayhead(animation, layer.normalisedTime * spriteAnimationDurationMs(animation), false).index
    : -1;
  const view = index >= 0 ? views[index] : undefined;
  const frame = index >= 0 ? resolved.frames[index] : undefined;
  const textureKey = [...new Set(views.map((entry) => entry.textureGuid).filter(Boolean))].join("|");
  const textureGuids = useMemo(() => (textureKey ? textureKey.split("|") : []), [textureKey]);
  const previewFor = useTexturePreviews(textureGuids);
  const url = previewFor(view?.textureGuid).url;
  const width = view?.rect?.width ?? frame?.width ?? 1;
  const height = view?.rect?.height ?? frame?.height ?? 1;
  const flip: CSSProperties = {
    aspectRatio: `${width} / ${height}`,
    transform: `scale(${layer?.flipX ? -1 : 1}, ${layer?.flipY ? -1 : 1})`,
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewTransport />
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        style={{ backgroundImage: CHECKERBOARD, backgroundSize: "16px 16px" }}
        data-testid="anim-preview-2d"
        data-frame-index={String(index)}
        data-flip-x={layer?.flipX ? "true" : "false"}
        data-flip-y={layer?.flipY ? "true" : "false"}
      >
        {url ? (
          <div className="relative max-h-full max-w-full" style={{ ...flip, height: "100%" }}>
            <FrameImage url={url} view={view} />
          </div>
        ) : null}
      </div>
      <PreviewClock api={api} />
    </div>
  );
}

/** Runs the session while the window shows; renders nothing. */
function PreviewClock({ api }: { api: IDockviewPanelProps["api"] }) {
  usePreviewClock(api);
  return null;
}

/**
 * The Animation Graph's Preview window: the graph running on a Model on its Skeleton (3D) or as frames (2D), with
 * Play, Pause, Step, Restart and Speed, and the active state and its time.
 */
export function AnimGraphPreviewPanel(props: IDockviewPanelProps) {
  const { dimension } = useAnimGraphDocument();
  return (
    <PanelFrame data-testid="anim-preview-panel">
      {dimension === "3d" ? <Preview3D api={props.api} /> : <Preview2D api={props.api} />}
    </PanelFrame>
  );
}

function previewValueRow(variable: AnimGraphVariable, value: unknown, onChange: (value: unknown) => void): PropertyRow[] {
  switch (variable.typeId) {
    case "bool":
      return [{ id: variable.id, kind: "boolean", label: variable.name, value: value === true, onChange }];
    case "int":
      return [{ id: variable.id, kind: "number", label: variable.name, value: typeof value === "number" ? value : 0, precision: 0, onChange: (next) => onChange(Math.round(next)) }];
    case "float":
      return [{ id: variable.id, kind: "number", label: variable.name, value: typeof value === "number" ? value : 0, onChange }];
    case "string":
      return [{ id: variable.id, kind: "text", label: variable.name, value: typeof value === "string" ? value : "", onChange }];
    case "tag":
    case "struct":
      return variableDefaultPropertyRows(variable.typeId, value, onChange, { typeClassId: variable.typeClassId, pinId: variable.id })
        .map((row) => ({ ...row, label: variable.name }));
  }
}

/** Preview Values: each variable's value while the Preview runs, standing in for what the Animation Object sets. */
export function AnimGraphPreviewValuesPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc } = useAnimGraphDocument();
  const session = useAnimGraphPreview();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const rows = doc.variables.flatMap((variable) =>
    previewValueRow(variable, snapshot.values[variable.name], (value) => session.setValue(variable.name, value)));
  return (
    <PanelFrame data-testid="anim-preview-values">
      {rows.length > 0 ? (
        <>
          <PropertyGrid rows={rows} />
          <div className="flex px-2 py-1.5">
            <Button type="button" variant="outline" size="sm" data-testid="anim-preview-values-reset" onClick={() => session.resetValues()}>
              Reset Values
            </Button>
          </div>
        </>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground">Add a Variable to set its value here while the Preview runs.</p>
      )}
    </PanelFrame>
  );
}
