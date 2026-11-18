import { memo, useCallback, useEffect, useMemo, useRef, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import type { ViewportZoomDirection, ViewportZoomDrive } from "@haptic/render";
import { Button } from "@haptic/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { useViewportZoomButtons } from "../context/app-settings-context";

export interface ViewportZoomControlsProps {
  /** The viewport's zoom drive, read at each press so an Engine swap needs no re-render. */
  drive: () => ViewportZoomDrive | null | undefined;
  disabled?: boolean;
  testId?: string;
}

/**
 * Accessibility **Viewport Zoom Buttons**: Zoom In above Zoom Out, for zooming a viewport without a pinch.
 * Renders nothing while the setting is off. A press zooms until release (a short one glides one tap step);
 * keyboard activation zooms one step.
 */
export const ViewportZoomControls = memo(function ViewportZoomControls(props: ViewportZoomControlsProps) {
  const enabled = useViewportZoomButtons();
  return enabled ? <ZoomIsland {...props} /> : null;
});

interface ActivePress {
  pointerId: number;
  /** The drive the press started, so release reaches it even if the Engine changed meanwhile. */
  drive: ViewportZoomDrive | null;
}

function ZoomIsland({ drive, disabled = false, testId = "viewport-zoom-controls" }: ViewportZoomControlsProps) {
  // Refs only during a press: holding a button re-renders nothing.
  const driveRef = useRef(drive);
  driveRef.current = drive;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const pressRef = useRef<ActivePress | null>(null);
  // Set by a pointer press so its trailing click does not zoom a second time.
  const pointerClickRef = useRef(false);

  const release = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    press.drive?.stop();
  }, []);

  useEffect(() => {
    if (disabled) release();
  }, [disabled, release]);

  useEffect(() => {
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [release]);

  const handlers = useMemo(() => {
    const forDirection = (direction: ViewportZoomDirection) => ({
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        // The viewport root opens its context menu on a long press; a held button must not reach it.
        event.stopPropagation();
        if (event.button !== 0) return;
        pointerClickRef.current = true;
        if (disabledRef.current || pressRef.current) return;
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // A pointer that already ended cannot be captured; its up still arrives on the button.
        }
        const current = driveRef.current() ?? null;
        pressRef.current = { pointerId: event.pointerId, drive: current };
        current?.start(direction);
      },
      onPointerEnd: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.type === "pointercancel") pointerClickRef.current = false;
        if (pressRef.current?.pointerId === event.pointerId) release();
      },
      onKeyDown: () => {
        pointerClickRef.current = false;
      },
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (pointerClickRef.current) {
          pointerClickRef.current = false;
          return;
        }
        // Keyboard or assistive-technology activation: one whole step.
        if (disabledRef.current) return;
        driveRef.current()?.step(direction);
      },
    });
    return { in: forDirection(1), out: forDirection(-1) };
  }, [release]);

  return (
    <div
      role="group"
      aria-label="Viewport Zoom"
      data-testid={testId}
      className="toolbar-island toolbar-island-vertical pointer-events-auto"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ZoomButton label="Zoom In" testId="viewport-zoom-in" disabled={disabled} handlers={handlers.in}>
        <PlusIcon />
      </ZoomButton>
      <ZoomButton label="Zoom Out" testId="viewport-zoom-out" disabled={disabled} handlers={handlers.out}>
        <MinusIcon />
      </ZoomButton>
    </div>
  );
}

function ZoomButton({
  label,
  testId,
  disabled,
  handlers,
  children,
}: {
  label: string;
  testId: string;
  disabled: boolean;
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerEnd: (event: PointerEvent<HTMLButtonElement>) => void;
    onKeyDown: () => void;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  };
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="touch-icon"
            aria-label={label}
            data-testid={testId}
            disabled={disabled}
            className="touch-none select-none"
            onPointerDown={handlers.onPointerDown}
            onPointerUp={handlers.onPointerEnd}
            onPointerCancel={handlers.onPointerEnd}
            onLostPointerCapture={handlers.onPointerEnd}
            onKeyDown={handlers.onKeyDown}
            onClick={handlers.onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
