import { useCallback, useRef, useState, type PointerEvent } from "react";
import { parseSpriteCollision, resizeSpriteCollision, type SpriteCollision } from "@haptic/assets";
import { cn } from "@haptic/ui/lib/utils";

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type CollisionHandle = (typeof HANDLES)[number];

const HANDLE_LABEL: Record<CollisionHandle, string> = {
  n: "North",
  s: "South",
  e: "East",
  w: "West",
  ne: "Northeast",
  nw: "Northwest",
  se: "Southeast",
  sw: "Southwest",
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizedFromPointer(
  host: DOMRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return {
    x: host.width > 0 ? clamp01((clientX - host.left) / host.width) : 0,
    y: host.height > 0 ? clamp01((clientY - host.top) / host.height) : 0,
  };
}

/** Frame size in texture pixels: edges snap to whole pixels and the readout counts them. */
type FramePixels = { width: number; height: number };

function snapToPixels(box: SpriteCollision, pixels: FramePixels | null | undefined): SpriteCollision {
  if (!pixels) return box;
  const snap = (start: number, size: number, count: number) => {
    const first = Math.round(start * count);
    const last = Math.max(first + 1, Math.round((start + size) * count));
    return { start: first / count, size: (Math.min(count, last) - first) / count };
  };
  const x = snap(box.x, box.width, pixels.width);
  const y = snap(box.y, box.height, pixels.height);
  return { x: x.start, y: y.start, width: x.size, height: y.size };
}

function applyHandle(
  start: SpriteCollision,
  handle: CollisionHandle | "move",
  pointer: { x: number; y: number },
  origin: { x: number; y: number },
  pixels: FramePixels | null | undefined,
): SpriteCollision {
  return snapToPixels(resizeSpriteCollision(start, handle, pointer, origin), pixels);
}

function collisionLabel(box: SpriteCollision, pixels: FramePixels | null | undefined): string {
  if (!pixels) {
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    return `${percent(box.x)}, ${percent(box.y)} · ${percent(box.width)} × ${percent(box.height)}`;
  }
  const px = (value: number, count: number) => Math.round(value * count);
  return `${px(box.x, pixels.width)}, ${px(box.y, pixels.height)} · ${px(box.width, pixels.width)} × ${px(box.height, pixels.height)} px`;
}

const HANDLE_CLASS: Record<CollisionHandle, string> = {
  n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  s: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
  e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
  sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
};

export function SpriteCollisionOverlay({
  collision,
  pixels,
  onChange,
}: {
  collision: SpriteCollision;
  /** The frame's texture pixel size, when known. */
  pixels?: FramePixels | null;
  onChange: (next: SpriteCollision) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    handle: CollisionHandle | "move";
    start: SpriteCollision;
    origin: { x: number; y: number };
  } | null>(null);
  const [live, setLive] = useState<SpriteCollision | null>(null);
  const box = live ?? parseSpriteCollision(collision);

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const host = hostRef.current?.getBoundingClientRect();
      const session = drag.current;
      if (!host || !session) return;
      const pointer = normalizedFromPointer(host, clientX, clientY);
      const next = applyHandle(session.start, session.handle, pointer, session.origin, pixels);
      setLive(next);
      onChange(next);
    },
    [onChange, pixels],
  );

  const beginDrag = (
    handle: CollisionHandle | "move",
    event: PointerEvent,
  ) => {
    const host = hostRef.current?.getBoundingClientRect();
    if (!host) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = normalizedFromPointer(host, event.clientX, event.clientY);
    const start = parseSpriteCollision(collision);
    drag.current = { handle, start, origin };
    setLive(start);
  };

  const endDrag = (event: PointerEvent) => {
    if (!drag.current) return;
    updateFromPointer(event.clientX, event.clientY);
    drag.current = null;
    setLive(null);
  };
  const dragging = live !== null;

  return (
    <div
      ref={hostRef}
      data-testid="sprite-collision-host"
      // Only the box and its handles take pointers, so the preview still pans around them.
      className="pointer-events-none absolute inset-0 z-20"
      onPointerMove={(event) => {
        if (!drag.current) return;
        updateFromPointer(event.clientX, event.clientY);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-testid="sprite-collision-overlay"
        className={cn(
          "pointer-events-auto absolute cursor-move border border-primary bg-primary/10",
          dragging ? "border-solid bg-primary/20" : "border-dashed",
        )}
        style={{
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
        }}
        onPointerDown={(event) => beginDrag("move", event)}
      >
        {HANDLES.map((handle) => (
          <button
            key={handle}
            type="button"
            data-testid={`sprite-collision-handle-${handle}`}
            aria-label={`Resize Collision ${HANDLE_LABEL[handle]}`}
            className={cn(
              "absolute size-4 p-0 pointer-coarse:size-11",
              HANDLE_CLASS[handle],
            )}
            onPointerDown={(event) => beginDrag(handle, event)}
          >
            <span className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-background bg-primary" />
          </button>
        ))}
        <span
          data-testid="sprite-collision-readout"
          className={cn(
            "pointer-events-none absolute bottom-full left-0 mb-1.5 whitespace-nowrap rounded-sm bg-background/85 px-1 text-[11px] tabular-nums text-foreground",
            !dragging && "hidden",
          )}
        >
          {collisionLabel(box, pixels)}
        </span>
      </div>
    </div>
  );
}
