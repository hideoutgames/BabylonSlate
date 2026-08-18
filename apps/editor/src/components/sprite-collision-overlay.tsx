import { useCallback, useRef, useState, type PointerEvent } from "react";
import { parseSpriteCollision, resizeSpriteCollision, type SpriteCollision } from "@babylonslate/assets";
import { cn } from "@babylonslate/ui/lib/utils";

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type CollisionHandle = (typeof HANDLES)[number];

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

function applyHandle(
  start: SpriteCollision,
  handle: CollisionHandle | "move",
  pointer: { x: number; y: number },
  origin: { x: number; y: number },
): SpriteCollision {
  return resizeSpriteCollision(start, handle, pointer, origin);
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
  onChange,
}: {
  collision: SpriteCollision;
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
      const next = applyHandle(session.start, session.handle, pointer, session.origin);
      setLive(next);
      onChange(next);
    },
    [onChange],
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
    drag.current = {
      handle,
      start: parseSpriteCollision(collision),
      origin,
    };
  };

  const endDrag = (event: PointerEvent) => {
    if (!drag.current) return;
    updateFromPointer(event.clientX, event.clientY);
    drag.current = null;
    setLive(null);
  };

  return (
    <div
      ref={hostRef}
      data-testid="sprite-collision-host"
      className="absolute inset-0 z-20"
      onPointerMove={(event) => {
        if (!drag.current) return;
        updateFromPointer(event.clientX, event.clientY);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-testid="sprite-collision-overlay"
        className="absolute border border-dashed border-primary"
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
            aria-label={`Resize collision ${handle}`}
            className={cn(
              "absolute size-[var(--touch-target)] min-h-[var(--touch-target)] min-w-[var(--touch-target)] p-0",
              HANDLE_CLASS[handle],
            )}
            onPointerDown={(event) => beginDrag(handle, event)}
          >
            <span className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-primary" />
          </button>
        ))}
      </div>
    </div>
  );
}
