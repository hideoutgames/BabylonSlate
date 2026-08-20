import { useCallback, useRef, useState, type PointerEvent } from "react";
import {
  parseSkyboxCreatorSourcePlacement,
  resizeSkyboxCreatorSourcePlacement,
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
  const drag = useRef<{
    handle: SkyboxCreatorSourcePlacementHandle;
    start: SkyboxCreatorSourcePlacement;
    origin: { x: number; y: number };
  } | null>(null);
  const [live, setLive] = useState<SkyboxCreatorSourcePlacement | null>(null);
  const box = live ?? parseSkyboxCreatorSourcePlacement(placement) ?? placement;

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const host =
        getNetRect?.() ??
        hostRef.current
          ?.closest("[data-testid='skybox-creator-net']")
          ?.getBoundingClientRect() ??
        hostRef.current?.getBoundingClientRect();
      const session = drag.current;
      if (!host || !session) return;
      const pointer = netPoint(host, clientX, clientY);
      const next = resizeSkyboxCreatorSourcePlacement(
        session.start,
        session.handle,
        pointer,
        session.origin,
      );
      setLive(next);
      onChange(next);
    },
    [getNetRect, onChange],
  );

  const beginDrag = (
    handle: SkyboxCreatorSourcePlacementHandle,
    event: PointerEvent,
  ) => {
    const host =
      getNetRect?.() ??
      hostRef.current
        ?.closest("[data-testid='skybox-creator-net']")
        ?.getBoundingClientRect() ??
      hostRef.current?.getBoundingClientRect();
    if (!host) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const client = eventClient(event);
    drag.current = {
      handle,
      start: parseSkyboxCreatorSourcePlacement(placement) ?? placement,
      origin: netPoint(host, client.x, client.y),
    };
  };

  const endDrag = (event: PointerEvent) => {
    if (!drag.current) return;
    const client = eventClient(event);
    updateFromPointer(client.x, client.y);
    drag.current = null;
    setLive(null);
  };

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 z-10"
      onPointerMove={(event) => {
        if (!drag.current) return;
        const client = eventClient(event);
        updateFromPointer(client.x, client.y);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-testid="skybox-creator-source"
        className="absolute border border-dashed border-primary"
        style={{
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
        }}
        onPointerDown={(event) => beginDrag("move", event)}
      >
        {imageUrl ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <img
              src={imageUrl}
              alt=""
              className="h-full w-full object-fill"
            />
          </div>
        ) : null}
        {HANDLES.map((handle) => (
          <button
            key={handle}
            type="button"
            data-testid={`skybox-creator-source-handle-${handle}`}
            aria-label={`Resize Source ${HANDLE_LABEL[handle]}`}
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
