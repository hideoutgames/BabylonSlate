import { useCallback, useRef, useState, type PointerEvent } from "react";
import {
  parseSkyboxCreatorSourcePlacement,
  resizeSkyboxCreatorSourcePlacement,
  rotateSkyboxCreatorSourcePlacement,
  scaleSkyboxCreatorSourcePlacement,
  type SkyboxCreatorSourcePlacement,
  type SkyboxCreatorSourcePlacementHandle,
} from "@babylonslate/assets";
import { cn } from "@babylonslate/ui/lib/utils";

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

const HANDLE_LABEL: Record<(typeof HANDLES)[number], string> = {
  n: "North",
  s: "South",
  e: "East",
  w: "West",
  ne: "Northeast",
  nw: "Northwest",
  se: "Southeast",
  sw: "Southwest",
};

const HANDLE_CLASS: Record<(typeof HANDLES)[number], string> = {
  n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  s: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
  e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
  sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
};

function eventClient(event: PointerEvent): { x: number; y: number } {
  const native = event.nativeEvent;
  return {
    x: Number.isFinite(event.clientX)
      ? event.clientX
      : Number(native?.clientX) || 0,
    y: Number.isFinite(event.clientY)
      ? event.clientY
      : Number(native?.clientY) || 0,
  };
}

function netPoint(
  host: DOMRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const width = host.width;
  const height = host.height;
  return {
    x: width > 0 ? (clientX - host.left) / width : 0,
    y: height > 0 ? (clientY - host.top) / height : 0,
  };
}

type DragSession =
  | { kind: "handle"; handle: SkyboxCreatorSourcePlacementHandle; start: SkyboxCreatorSourcePlacement; origin: { x: number; y: number } }
  | { kind: "rotate"; start: SkyboxCreatorSourcePlacement; origin: { x: number; y: number } }
  | { kind: "pinch"; start: SkyboxCreatorSourcePlacement; spread: number };

/** Snap step for a rotation drag with Shift held. */
const ROTATE_SNAP_DEGREES = 15;

function spreadOf(points: Iterable<{ x: number; y: number }>): number {
  const [a, b] = [...points];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

/**
 * The source image on the net: drag to move, the eight handles to resize,
 * the handle above to rotate (Shift snaps to 15 degrees) and two fingers to
 * scale. Inside the net it draws at full strength; outside, half-transparent.
 */
export function SkyboxCreatorSourceOverlay({
  placement,
  imageUrl,
  onChange,
  getNetRect,
}: {
  placement: SkyboxCreatorSourcePlacement;
  imageUrl: string | null;
  onChange: (next: SkyboxCreatorSourcePlacement) => void;
  getNetRect?: () => DOMRect | undefined;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSession | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [live, setLive] = useState<SkyboxCreatorSourcePlacement | null>(null);
  const box = live ?? parseSkyboxCreatorSourcePlacement(placement) ?? placement;
  const rotation = box.rotation ?? 0;

  const netRect = useCallback(
    () =>
      getNetRect?.() ??
      hostRef.current?.closest("[data-testid='skybox-creator-net']")?.getBoundingClientRect() ??
      hostRef.current?.getBoundingClientRect(),
    [getNetRect],
  );

  const update = useCallback(
    (clientX: number, clientY: number, shift: boolean) => {
      const host = netRect();
      const session = drag.current;
      if (!host || !session) return;
      let next: SkyboxCreatorSourcePlacement;
      if (session.kind === "pinch") {
        const spread = spreadOf(pointers.current.values());
        if (!(spread > 0) || !(session.spread > 0)) return;
        next = scaleSkyboxCreatorSourcePlacement(session.start, spread / session.spread);
      } else {
        const pointer = netPoint(host, clientX, clientY);
        next = session.kind === "rotate"
          ? rotateSkyboxCreatorSourcePlacement(session.start, pointer, session.origin, shift ? ROTATE_SNAP_DEGREES : 0)
          : resizeSkyboxCreatorSourcePlacement(session.start, session.handle, pointer, session.origin);
      }
      setLive(next);
      onChange(next);
    },
    [netRect, onChange],
  );

  const begin = (kind: "rotate" | SkyboxCreatorSourcePlacementHandle, event: PointerEvent) => {
    const host = netRect();
    if (!host) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const client = eventClient(event);
    pointers.current.set(event.pointerId, client);
    const start = live ?? parseSkyboxCreatorSourcePlacement(placement) ?? placement;
    if (pointers.current.size >= 2) {
      // A second finger anywhere on the image scales it about its centre.
      drag.current = { kind: "pinch", start, spread: spreadOf(pointers.current.values()) };
      return;
    }
    const origin = netPoint(host, client.x, client.y);
    drag.current = kind === "rotate"
      ? { kind: "rotate", start, origin }
      : { kind: "handle", handle: kind, start, origin };
    setLive(start);
  };

  const end = (event: PointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size > 0) {
      // Lifting one finger of a pinch keeps the scale; the next gesture starts fresh.
      drag.current = null;
      return;
    }
    if (drag.current && drag.current.kind !== "pinch") {
      const client = eventClient(event);
      update(client.x, client.y, event.shiftKey);
    }
    drag.current = null;
    setLive(null);
  };

  const frame = {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
  };

  return (
    <div
      ref={hostRef}
      // Only the image and its handles take pointers, so the artboard pans around them.
      className="pointer-events-none absolute inset-0 z-10"
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        const client = eventClient(event);
        pointers.current.set(event.pointerId, client);
        if (drag.current) update(client.x, client.y, event.shiftKey);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {imageUrl ? (
        <div className="absolute inset-0 overflow-hidden" data-testid="skybox-creator-source-inside">
          <img src={imageUrl} alt="" draggable={false} className="absolute h-full w-full max-w-none object-fill" style={frame} />
        </div>
      ) : null}
      <div
        data-testid="skybox-creator-source"
        data-rotation={rotation}
        className={cn(
          "pointer-events-auto absolute cursor-move touch-none border border-primary",
          live ? "border-solid" : "border-dashed",
        )}
        style={frame}
        onPointerDown={(event) => begin("move", event)}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            // Outside the net the image stays visible at half strength; inside, the clipped copy covers it.
            className="pointer-events-none absolute inset-0 h-full w-full max-w-none select-none object-fill opacity-50"
          />
        ) : null}
        <span aria-hidden className="pointer-events-none absolute bottom-full left-1/2 h-5 w-px -translate-x-1/2 bg-primary" />
        <button
          type="button"
          data-testid="skybox-creator-source-rotate"
          aria-label="Rotate Source"
          className="absolute bottom-full left-1/2 mb-5 size-5 -translate-x-1/2 translate-y-1/2 cursor-grab p-0 active:cursor-grabbing pointer-coarse:size-11"
          onPointerDown={(event) => begin("rotate", event)}
        >
          <span className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-primary" />
        </button>
        {HANDLES.map((handle) => (
          <button
            key={handle}
            type="button"
            data-testid={`skybox-creator-source-handle-${handle}`}
            aria-label={`Resize Source ${HANDLE_LABEL[handle]}`}
            className={cn("absolute size-4 p-0 pointer-coarse:size-11", HANDLE_CLASS[handle])}
            onPointerDown={(event) => begin(handle, event)}
          >
            <span className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-background bg-primary" />
          </button>
        ))}
      </div>
    </div>
  );
}
