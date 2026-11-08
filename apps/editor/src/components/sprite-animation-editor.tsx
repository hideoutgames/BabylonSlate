import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  AtlasTileGrid,
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  ToolbarStrip,
  assetRowIdentity,
  useAssetOpen,
  type PropertyRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Slider } from "@haptic/ui/components/slider";
import { Toggle } from "@haptic/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import {
  createDefaultSpriteAnimationPayload,
  parseSpriteAnimationPayload,
  parseSpriteCollision,
  parseSpritePivot,
  spriteAnimationDurationMs,
  spriteAnimationFrameStartMs,
  spriteAnimationPlayhead,
  spriteAnimationSheetCellCount,
  spriteAnimationSheetGrid,
  type SpriteAnimationFrame,
  type SpriteAnimationPayload,
  type SpriteAnimationSource,
  type TileRect,
} from "@haptic/assets";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalSpriteAnimationEditing } from "../context/sprite-animation-editing-context";
import { SpriteCollisionOverlay } from "./sprite-collision-overlay";
import { objectContainRect } from "../lib/object-contain";
import { IconActionButton } from "./icon-action-button";
import { TexturePreviewStatus, useTexturePreviews } from "./texture-preview-status";
import { useResolvedSpriteAnimation, type SpriteAnimationFrameView } from "./sprite-animation-sources";
import {
  ExternalLinkIcon,
  Grid3x3Icon,
  ImageIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  Trash2Icon,
} from "lucide-react";

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const CHECKERBOARD =
  "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%)";

function useSpriteAnimationSelection(frameCount: number) {
  const ctx = useOptionalSpriteAnimationEditing();
  const [localIndex, setLocalIndex] = useState(0);
  const selectedFrameIndex = ctx?.selectedFrameIndex ?? localIndex;
  const setSelectedFrameIndex = ctx?.setSelectedFrameIndex ?? setLocalIndex;
  const clamped =
    frameCount <= 0
      ? 0
      : Math.min(Math.max(0, selectedFrameIndex), frameCount - 1);
  useEffect(() => {
    if (clamped !== selectedFrameIndex) setSelectedFrameIndex(clamped);
  }, [clamped, selectedFrameIndex, setSelectedFrameIndex]);
  return { selectedFrameIndex: clamped, setSelectedFrameIndex };
}

function useAnimation(payload: Record<string, unknown>): SpriteAnimationPayload {
  return useMemo(() => parseSpriteAnimationPayload(payload), [payload]);
}

/** A new frame: a Texture frame, or in a sheet the cell after `afterCell`. */
function newFrame(animation: SpriteAnimationPayload, afterCell?: number): SpriteAnimationFrame {
  const frame: SpriteAnimationFrame = {
    ...createDefaultSpriteAnimationPayload().frames[0]!,
    durationMs: animation.frameDurationMs,
  };
  if (animation.source === "sheet") frame.cell = (afterCell ?? 0) + 1;
  return frame;
}

const EMPTY_PAYLOAD: Record<string, unknown> = {};

export function SpriteAnimationPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? EMPTY_PAYLOAD) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-animation-preview-panel">
      <SpriteAnimationPreview
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

export function SpriteAnimationDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const payload = (doc?.content ?? EMPTY_PAYLOAD) as Record<string, unknown>;
  return (
    <PanelFrame data-testid="sprite-animation-details-panel">
      <SpriteAnimationDetails
        payload={payload}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

/** One scrub or drag on a frame field is one undo step. */
function spriteFrameMergeKey(frameIndex: number, field: string): string {
  return `sprite-animation:frame:${frameIndex}:${field}`;
}

function sliderNumber(next: number | readonly number[]): number | undefined {
  const value = Array.isArray(next) ? next[0] : next;
  return typeof value === "number" ? value : undefined;
}

/** The frame's pixel size: its region, else its resolved size; null when unknown. */
function framePixels(view: SpriteAnimationFrameView | undefined, frame: SpriteAnimationFrame | undefined) {
  if (view?.rect) return { width: view.rect.width, height: view.rect.height };
  if (frame?.width && frame.width > 0 && frame.height && frame.height > 0) return { width: frame.width, height: frame.height };
  return null;
}

/** Places the whole Texture so `rect` of it fills the box it sits in. */
function cropStyle(rect: TileRect, atlas: { width: number; height: number }): CSSProperties {
  return {
    left: `${(-rect.x / rect.width) * 100}%`,
    top: `${(-rect.y / rect.height) * 100}%`,
    width: `${(atlas.width / rect.width) * 100}%`,
    height: `${(atlas.height / rect.height) * 100}%`,
  };
}

/** The frame's image inside its box: a sheet cell is cropped from the sheet, other frames show the whole Texture. */
function FrameImage({
  url,
  view,
  className,
  onError,
}: {
  url: string;
  view: SpriteAnimationFrameView | undefined;
  className?: string;
  onError?: () => void;
}) {
  if (view?.rect && view.atlas) {
    return (
      <div className="absolute inset-0 overflow-hidden">
        <img
          src={url}
          alt=""
          draggable={false}
          onError={onError}
          className={cn("absolute max-w-none [image-rendering:pixelated]", className)}
          style={cropStyle(view.rect, view.atlas)}
        />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      onError={onError}
      className={cn("absolute inset-0 size-full object-contain [image-rendering:pixelated]", className)}
    />
  );
}

function boxStyle(box: { left: number; top: number; width: number; height: number }): CSSProperties {
  return {
    left: `${box.left * 100}%`,
    top: `${box.top * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  };
}

/** Frame and time beside the scrubber, on one line at a steady width while it plays. */
function PlaybackPosition({
  frameIndex,
  frameCount,
  timeMs,
  durationMs,
}: {
  frameIndex: number;
  frameCount: number;
  timeMs: number;
  durationMs: number;
}) {
  const frameDigits = String(frameCount).length;
  const timeDigits = String(durationMs).length;
  return (
    <span
      className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
      data-testid="sprite-animation-position"
    >
      Frame{" "}
      <span className="inline-block text-right text-foreground" style={{ minWidth: `${frameDigits}ch` }}>
        {frameIndex + 1}
      </span>
      /{frameCount}
      {" · "}
      <span className="inline-block text-right text-foreground" style={{ minWidth: `${timeDigits}ch` }}>
        {Math.round(timeMs)}
      </span>
      /{durationMs} ms
    </span>
  );
}

/**
 * The preview's play time in ms. A store rather than React state, so playback
 * re-renders only the scrubber and its readout on each frame; the preview
 * re-renders when the frame changes.
 */
class PlaybackClock {
  private timeMs = 0;
  private readonly listeners = new Set<() => void>();

  get = (): number => this.timeMs;

  set(timeMs: number): void {
    if (timeMs === this.timeMs) return;
    this.timeMs = timeMs;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** Scrubber and position readout, which follow the clock on every frame. */
function PlaybackScrubber({
  clock,
  frameIndex,
  frameCount,
  durationMs,
  onSeek,
}: {
  clock: PlaybackClock;
  frameIndex: number;
  frameCount: number;
  durationMs: number;
  onSeek: (timeMs: number) => void;
}) {
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  return (
    <>
      <Slider
        className="min-w-0 flex-1"
        min={0}
        max={durationMs}
        step={1}
        value={timeMs}
        aria-label="Playback"
        data-testid="sprite-animation-scrubber"
        onValueChange={(next) => {
          const value = sliderNumber(next);
          if (value !== undefined) onSeek(value);
        }}
      />
      <PlaybackPosition
        frameIndex={frameIndex}
        frameCount={frameCount}
        timeMs={timeMs}
        durationMs={durationMs}
      />
    </>
  );
}

type PreviewView = "frame" | "sheet";

export function SpriteAnimationPreview({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** A collision drag passes one merge key so the whole drag is one undo step. */
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const animation = useAnimation(payload);
  const { resolved, views, sheetAtlas } = useResolvedSpriteAnimation(animation);
  const { selectedFrameIndex, setSelectedFrameIndex } =
    useSpriteAnimationSelection(animation.frames.length);
  const frame = resolved.frames[selectedFrameIndex];
  const view = views[selectedFrameIndex];
  const textureKey = [...new Set(views.map((entry) => entry.textureGuid).filter(Boolean))].join("|");
  const textureGuids = useMemo(() => (textureKey ? textureKey.split("|") : []), [textureKey]);
  const previewFor = useTexturePreviews(textureGuids);
  const preview = previewFor(view?.textureGuid);
  const { url } = preview;
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [clock] = useState(() => new PlaybackClock());
  const [viewMode, setViewMode] = useState<PreviewView>("frame");
  const showSheet = animation.source === "sheet" && viewMode === "sheet";
  const durationMs = spriteAnimationDurationMs(animation);
  const animationRef = useRef(animation);
  animationRef.current = animation;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const lastTickRef = useRef(0);
  const selectedFrameIndexRef = useRef(selectedFrameIndex);
  selectedFrameIndexRef.current = selectedFrameIndex;

  useEffect(() => {
    if (!playing) return;
    const head = spriteAnimationPlayhead(
      animationRef.current,
      clock.get(),
      loopRef.current,
    );
    if (head.index !== selectedFrameIndexRef.current) {
      clock.set(spriteAnimationFrameStartMs(
        animationRef.current,
        selectedFrameIndexRef.current,
      ));
    }
    lastTickRef.current = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      const elapsed = clock.get() + (now - lastTickRef.current);
      lastTickRef.current = now;
      const next = spriteAnimationPlayhead(
        animationRef.current,
        elapsed,
        loopRef.current,
      );
      clock.set(next.timeMs);
      setSelectedFrameIndex(next.index);
      if (next.finished) {
        setPlaying(false);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [clock, playing, setSelectedFrameIndex]);

  const pivot = parseSpritePivot(frame?.pivot);
  const collision = parseSpriteCollision(frame?.collision);
  const pixels = framePixels(view, frame);
  const contain = pixels
    ? objectContainRect(1, 1, pixels.width, pixels.height)
    : { left: 0, top: 0, width: 1, height: 1 };
  // A Sprite frame shows the Sprite's collision; edit it in the Sprite.
  const fromSprite = animation.source === "frames" && Boolean(animation.frames[selectedFrameIndex]?.spriteGuid);

  const seekToFrame = (index: number) => {
    setPlaying(false);
    setSelectedFrameIndex(index);
    clock.set(spriteAnimationFrameStartMs(animation, index));
  };

  const seekToTime = (nextTimeMs: number) => {
    setPlaying(false);
    const head = spriteAnimationPlayhead(animation, nextTimeMs, false);
    clock.set(head.timeMs);
    setSelectedFrameIndex(head.index);
  };

  const sheetGrid = useMemo(
    () => spriteAnimationSheetGrid(animation.sheet, sheetAtlas ?? { width: 0, height: 0 }),
    [animation.sheet, sheetAtlas],
  );
  const frameCells = useMemo(() => animation.frames.map((entry) => entry.cell ?? 1), [animation.frames]);

  const frameCount = animation.frames.length;
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="sprite-animation-preview"
      data-playing={playing ? "true" : "false"}
      data-frame-index={String(selectedFrameIndex)}
    >
      <ToolbarStrip className="shrink-0 gap-2 py-1" data-testid="sprite-animation-playback">
        <Button
          type="button"
          size="sm"
          variant={playing ? "secondary" : "default"}
          className={TOOL_ITEM}
          data-testid={playing ? "sprite-animation-pause" : "sprite-animation-play"}
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? <PauseIcon fill="currentColor" /> : <PlayIcon fill="currentColor" />}
          {playing ? "Pause" : "Play"}
        </Button>
        <Toggle
          size="sm"
          variant="outline"
          className={TOOL_ITEM}
          pressed={loop}
          aria-label="Loop"
          data-testid="sprite-animation-loop"
          onPressedChange={setLoop}
        >
          <RepeatIcon />
          Loop
        </Toggle>
        {animation.source === "sheet" ? (
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[viewMode]}
            onValueChange={(value) => {
              const next = value[0] as PreviewView | undefined;
              if (next) setViewMode(next);
            }}
            aria-label="Preview"
            data-testid="sprite-animation-view"
          >
            <ToggleGroupItem value="frame" className={TOOL_ITEM} data-testid="sprite-animation-view-frame">
              <ImageIcon />
              Frame
            </ToggleGroupItem>
            <ToggleGroupItem value="sheet" className={TOOL_ITEM} data-testid="sprite-animation-view-sheet">
              <Grid3x3Icon />
              Sheet
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </ToolbarStrip>
      {showSheet ? (
        <AtlasTileGrid
          tileset={sheetGrid}
          imageUrl={url}
          selectedId={frameCells[selectedFrameIndex] ?? 1}
          selectedIds={frameCells}
          panZoom
          tool="select"
          emptyLabel={preview.status === "empty" ? "No Texture" : preview.status === "missing" ? "Missing Texture" : preview.status === "failed" ? "Texture Preview Failed" : "Loading Texture…"}
          emptyDescription={preview.status === "empty" ? "Pick the sheet's Texture in the Inspector." : undefined}
          data-testid="sprite-animation-sheet"
          onSelect={(cell) => {
            if (!onChange) return;
            const frames = animation.frames.map((entry, index) =>
              index === selectedFrameIndex ? { ...entry, cell } : entry,
            );
            onChange({ ...animation, frames });
          }}
          onSelectionChange={(cells) => {
            if (!onChange || cells.length === 0) return;
            // A drag makes the covered cells the frames, in reading order; the drag is one undo step.
            const frames = cells.map((cell, index) => ({ ...(animation.frames[index] ?? newFrame(animation)), cell }));
            onChange({ ...animation, frames }, "sprite-animation:sheet-cells");
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-sidebar p-3 [container-type:size]">
          <div
            className="relative aspect-square w-[min(100cqw,100cqh)] overflow-hidden rounded-md ring-1 ring-border"
            style={{ backgroundImage: CHECKERBOARD, backgroundSize: "16px 16px" }}
          >
            {!url && !playing ? (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/90">
                <TexturePreviewStatus preview={preview} />
              </div>
            ) : null}
            <div
              data-testid="sprite-animation-image-box"
              className="absolute z-10"
              style={boxStyle(contain)}
            >
              {url ? <FrameImage url={url} view={view} onError={preview.fail} /> : null}
              <div
                data-testid="sprite-pivot-marker"
                className="pointer-events-none absolute z-10"
                style={{
                  left: `${pivot.x * 100}%`,
                  top: `${pivot.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <div className="relative size-4">
                  <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-primary" />
                  <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-primary" />
                </div>
              </div>
              <SpriteCollisionOverlay
                collision={collision}
                pixels={pixels}
                onChange={
                  onChange && !fromSprite
                    ? (next) => {
                        const frames = animation.frames.map((entry, index) =>
                          index === selectedFrameIndex
                            ? { ...entry, collision: next }
                            : entry,
                        );
                        onChange(
                          { ...animation, frames },
                          spriteFrameMergeKey(selectedFrameIndex, "collision"),
                        );
                      }
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      )}
      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-panel-header px-2 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <PlaybackScrubber
            clock={clock}
            frameIndex={selectedFrameIndex}
            frameCount={frameCount}
            durationMs={durationMs}
            onSeek={seekToTime}
          />
        </div>
        <div
          className="flex gap-1.5 overflow-x-auto pb-0.5"
          role="group"
          aria-label="Frames"
          data-testid="sprite-animation-frame-strip"
        >
          {animation.frames.map((entry, index) => (
            <SpriteAnimationFrameThumb
              key={index}
              index={index}
              url={previewFor(views[index]?.textureGuid).url}
              view={views[index]}
              pixels={framePixels(views[index], resolved.frames[index])}
              durationMs={entry.durationMsOverride ? entry.durationMs : undefined}
              selected={index === selectedFrameIndex}
              onSelect={() => seekToFrame(index)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SpriteAnimationFrameThumb({
  index,
  url,
  view,
  pixels,
  durationMs,
  selected,
  onSelect,
}: {
  index: number;
  url: string | null;
  view: SpriteAnimationFrameView | undefined;
  pixels: { width: number; height: number } | null;
  durationMs?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const contain = pixels
    ? objectContainRect(1, 1, pixels.width, pixels.height)
    : { left: 0, top: 0, width: 1, height: 1 };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid={`sprite-animation-frame-${index}`}
      aria-pressed={selected}
      aria-label={`Frame ${index + 1}`}
      onClick={onSelect}
      className={cn(
        "relative size-12 shrink-0 overflow-hidden rounded-md p-0 ring-1 ring-border hover:ring-foreground/40",
        selected && "ring-2 ring-(--graph-state-selected) hover:ring-(--graph-state-selected)",
      )}
      style={{ backgroundImage: CHECKERBOARD, backgroundSize: "8px 8px" }}
    >
      {url ? (
        <span className="absolute inset-1">
          <span className="absolute" style={boxStyle(contain)}>
            <FrameImage url={url} view={view} />
          </span>
        </span>
      ) : null}
      <span className="absolute bottom-0.5 left-0.5 rounded-sm bg-background/85 px-1 text-[10px] font-medium leading-tight tabular-nums text-foreground">
        {index + 1}
      </span>
      {durationMs !== undefined ? (
        <span className="absolute right-0.5 top-0.5 rounded-sm bg-background/85 px-1 text-[10px] leading-tight tabular-nums text-muted-foreground">
          {durationMs}
        </span>
      ) : null}
    </Button>
  );
}

type PickerTarget = "frame" | "sheet";

export function SpriteAnimationDetails({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** `mergeKey` groups one scrub's edits into one undo entry. */
  onChange: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const animation = useAnimation(payload);
  const { resolved, sheetAtlas } = useResolvedSpriteAnimation(animation);
  const { selectedFrameIndex, setSelectedFrameIndex } =
    useSpriteAnimationSelection(animation.frames.length);
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const { assetRegistry, registryEpoch } = useRegistryState();
  const assetOpen = useAssetOpen();
  const assets = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  }, [assetRegistry, registryEpoch]);
  const sheet = animation.source === "sheet";
  const frame = animation.frames[selectedFrameIndex];
  const shown = resolved.frames[selectedFrameIndex];
  const spriteGuid = !sheet ? frame?.spriteGuid : undefined;
  const imageGuid = spriteGuid ?? (frame?.textureGuid || null);
  const imageAsset = imageGuid ? assets.find((asset) => asset.guid === imageGuid) : undefined;
  const sheetTexture = animation.sheet.textureGuid
    ? assets.find((asset) => asset.guid === animation.sheet.textureGuid)
    : undefined;
  const cellCount = sheetAtlas ? spriteAnimationSheetCellCount(animation.sheet, sheetAtlas) : 0;
  const collision = parseSpriteCollision(shown?.collision);
  const pivot = parseSpritePivot(shown?.pivot);

  /** `field` marks a continuous edit whose scrub is one undo step. */
  const patchFrame = (
    patch: Partial<SpriteAnimationFrame>,
    field?: string,
    remove: ReadonlyArray<keyof SpriteAnimationFrame> = [],
  ): void => {
    const frames = [...animation.frames];
    const current = frames[selectedFrameIndex];
    if (!current) return;
    const next = { ...current, ...patch };
    for (const key of remove) delete next[key];
    frames[selectedFrameIndex] = next;
    const updated = { ...animation, frames };
    if (field) onChange(updated, spriteFrameMergeKey(selectedFrameIndex, field));
    else onChange(updated);
  };

  const setDurationOverride = (override: boolean): void => {
    if (override) patchFrame({ durationMsOverride: true, durationMs: animation.frameDurationMs });
    else patchFrame({}, undefined, ["durationMsOverride"]);
  };

  /** A Sprite frame shows the Sprite; a Texture frame the whole Texture. Sizes come from the Texture. */
  const applyImage = (guid: string | null): void => {
    const type = guid ? assets.find((asset) => asset.guid === guid)?.type : undefined;
    if (guid && type === "Sprite") patchFrame({ spriteGuid: guid, textureGuid: "" }, undefined, ["width", "height"]);
    else patchFrame({ textureGuid: guid ?? "" }, undefined, ["spriteGuid", "width", "height"]);
  };

  const patchSheet = (patch: Partial<SpriteAnimationPayload["sheet"]>, mergeKey?: string): void => {
    const next = { ...animation, sheet: { ...animation.sheet, ...patch } };
    if (mergeKey) onChange(next, mergeKey);
    else onChange(next);
  };

  const setSource = (source: SpriteAnimationSource): void => {
    if (source === animation.source) return;
    if (source === "frames") {
      onChange({ ...animation, source });
      return;
    }
    // The first Texture frame becomes the sheet, and each frame a cell in order.
    const firstTexture = animation.frames.find((entry) => !entry.spriteGuid && entry.textureGuid)?.textureGuid ?? "";
    onChange({
      ...animation,
      source,
      sheet: animation.sheet.textureGuid ? animation.sheet : { ...animation.sheet, textureGuid: firstTexture },
      frames: animation.frames.map((entry, index) => ({ ...entry, cell: entry.cell ?? index + 1 })),
    });
  };

  const useAllCells = (): void => {
    if (cellCount <= 0) return;
    const frames = Array.from({ length: cellCount }, (_unused, index) => ({
      ...(animation.frames[index] ?? newFrame(animation)),
      cell: index + 1,
    }));
    onChange({ ...animation, frames });
  };

  const animationRows: PropertyRow[] = [
    {
      id: "source",
      kind: "enum",
      label: "Source",
      value: animation.source,
      options: [
        { value: "frames", label: "Frames" },
        { value: "sheet", label: "Sheet" },
      ],
      onChange: (value) => setSource(value === "sheet" ? "sheet" : "frames"),
    },
    {
      id: "frame-duration",
      kind: "number",
      label: "Frame Duration",
      unit: "ms",
      value: animation.frameDurationMs,
      min: 1,
      onChange: (frameDurationMs) =>
        onChange(
          { ...animation, frameDurationMs: Math.max(1, frameDurationMs) },
          "sprite-animation:frameDurationMs",
        ),
    },
  ];

  const sheetRows: PropertyRow[] = [
    {
      id: "sheet-texture",
      kind: "asset",
      label: "Texture",
      value: animation.sheet.textureGuid || null,
      placeholder: "None",
      onPick: () => setPickerTarget("sheet"),
      onChange: (value) => patchSheet({ textureGuid: value ?? "" }),
      ...assetRowIdentity(sheetTexture ? { name: sheetTexture.name, type: "Texture" } : undefined),
    },
    {
      id: "cell-width",
      kind: "number",
      label: "Cell Width",
      unit: "px",
      value: animation.sheet.cellWidth,
      min: 1,
      precision: 0,
      onChange: (value) => patchSheet({ cellWidth: Math.max(1, Math.round(value)) }, "sprite-animation:sheet:cellWidth"),
    },
    {
      id: "cell-height",
      kind: "number",
      label: "Cell Height",
      unit: "px",
      value: animation.sheet.cellHeight,
      min: 1,
      precision: 0,
      onChange: (value) => patchSheet({ cellHeight: Math.max(1, Math.round(value)) }, "sprite-animation:sheet:cellHeight"),
    },
    {
      id: "margin",
      kind: "number",
      label: "Margin",
      unit: "px",
      value: animation.sheet.margin,
      min: 0,
      precision: 0,
      onChange: (value) => patchSheet({ margin: Math.max(0, Math.round(value)) }, "sprite-animation:sheet:margin"),
    },
    {
      id: "spacing",
      kind: "number",
      label: "Spacing",
      unit: "px",
      value: animation.sheet.spacing,
      min: 0,
      precision: 0,
      onChange: (value) => patchSheet({ spacing: Math.max(0, Math.round(value)) }, "sprite-animation:sheet:spacing"),
    },
  ];

  const frameRows: PropertyRow[] = sheet
    ? [
        {
          id: "cell",
          kind: "number",
          label: "Cell",
          value: frame?.cell ?? 1,
          min: 1,
          ...(cellCount > 0 ? { max: cellCount } : {}),
          precision: 0,
          status: cellCount > 0 ? undefined : "Set the sheet's Texture to see its cells.",
          onChange: (value) => {
            const cell = Math.max(1, Math.round(value));
            patchFrame({ cell: cellCount > 0 ? Math.min(cellCount, cell) : cell }, "cell");
          },
        },
      ]
    : [
        {
          id: "image",
          kind: "asset",
          label: "Image",
          value: imageGuid,
          placeholder: "None",
              onPick: () => setPickerTarget("frame"),
          onChange: (value) => applyImage(value),
          ...assetRowIdentity(
            imageAsset ? { name: imageAsset.name, type: spriteGuid ? "Sprite" : "Texture" } : undefined,
          ),
        },
      ];
  frameRows.push({
    id: "frame-duration-override",
    kind: "boolean",
    label: "Frame Duration Override",
    value: frame?.durationMsOverride === true,
    onChange: setDurationOverride,
  });
  if (frame?.durationMsOverride) {
    frameRows.push({
      id: "override-frame-duration",
      kind: "number",
      label: "Frame Duration",
      unit: "ms",
      value: frame.durationMs,
      min: 1,
      onChange: (durationMs) =>
        patchFrame({ durationMs: Math.max(1, durationMs) }, "durationMs"),
    });
  }
  frameRows.push(
    {
      id: "pivot",
      kind: "vector3",
      label: "Pivot",
      value: [pivot.x, pivot.y, 0],
      axes: ["X", "Y"],
      disabled: Boolean(spriteGuid),
      onChange: ([x, y]) => patchFrame({ pivot: { x, y } }, "pivot"),
    },
    {
      id: "collision",
      kind: "vector3",
      label: "Collision",
      value: [collision.x, collision.y, collision.width, collision.height],
      axes: ["X", "Y", "W", "H"],
      disabled: Boolean(spriteGuid),
      ...(spriteGuid ? { description: "Pivot and Collision come from the Sprite." } : {}),
      onChange: ([x, y, width, height]) =>
        patchFrame(
          { collision: parseSpriteCollision({ x, y, width, height }) },
          "collision",
        ),
    },
  );

  const totalMs = spriteAnimationDurationMs(animation);
  const frameCount = animation.frames.length;
  return (
    <div data-testid="sprite-animation-editor" className="flex flex-col">
      <PropertySectionTitle
        aside={
          <span className="whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground" data-testid="sprite-animation-summary">
            {frameCount === 1 ? "1 Frame" : `${frameCount} Frames`} · {totalMs} ms
          </span>
        }
      >
        Animation
      </PropertySectionTitle>
      <PropertyGrid rows={animationRows} />
      {sheet ? (
        <>
          <PropertySectionTitle
            aside={
              <span className="flex items-center gap-2">
                <span className="whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground" data-testid="sprite-animation-cell-count">
                  {cellCount === 1 ? "1 Cell" : `${cellCount} Cells`}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn("h-6 px-2", TOOL_ITEM)}
                  disabled={cellCount <= 0}
                  data-testid="sprite-animation-use-all-cells"
                  onClick={useAllCells}
                >
                  Use All Cells
                </Button>
              </span>
            }
          >
            Sheet
          </PropertySectionTitle>
          <PropertyGrid rows={sheetRows} />
        </>
      ) : null}
      <PropertySectionTitle
        aside={
          <span className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("h-6 px-2", TOOL_ITEM)}
              data-testid="sprite-animation-add-frame"
              onClick={() => {
                const last = animation.frames[animation.frames.length - 1];
                const cell = sheet && cellCount > 0 ? Math.min(cellCount - 1, last?.cell ?? 0) : last?.cell;
                onChange({ ...animation, frames: [...animation.frames, newFrame(animation, cell)] });
                setSelectedFrameIndex(animation.frames.length);
              }}
            >
              <PlusIcon />
              Add Frame
            </Button>
            <IconActionButton
              label="Remove Frame"
              variant="ghost"
              className={cn("size-6", TOOL_ITEM)}
              disabled={frameCount <= 1}
              onClick={() => {
                const frames = animation.frames.filter(
                  (_entry, index) => index !== selectedFrameIndex,
                );
                onChange({
                  ...animation,
                  frames: frames.length > 0 ? frames : [newFrame(animation)],
                });
                setSelectedFrameIndex(Math.max(0, selectedFrameIndex - 1));
              }}
            >
              <Trash2Icon className="icon-sm" />
            </IconActionButton>
          </span>
        }
      >
        <span data-testid="sprite-animation-selected-frame">Frame {selectedFrameIndex + 1}</span>
      </PropertySectionTitle>
      <PropertyGrid rows={frameRows} />
      {spriteGuid && assetOpen ? (
        <div className="px-2 pb-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOOL_ITEM}
            data-testid="sprite-animation-open-sprite"
            onClick={() => assetOpen.openAsset(spriteGuid)}
          >
            <ExternalLinkIcon />
            Open Sprite
          </Button>
        </div>
      ) : null}
      <AssetPicker
        open={pickerTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPickerTarget(null);
        }}
        assets={assets}
        allowedTypes={pickerTarget === "frame" ? ["Texture", "Sprite"] : ["Texture"]}
        onPick={(guid) => {
          if (pickerTarget === "sheet") patchSheet({ textureGuid: guid ?? "" });
          else applyImage(guid);
          setPickerTarget(null);
        }}
        data-testid="sprite-animation-texture-picker"
      />
    </div>
  );
}
