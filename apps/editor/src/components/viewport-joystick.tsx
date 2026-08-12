import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_FLY_SPEED } from "@babylonslate/render";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  joystickValueFromPointer,
  VIEWPORT_JOYSTICK_RADIUS,
  type JoystickValue,
} from "./viewport-joystick-math";

export interface ViewportJoystickProps {
  /** Called every animation frame while the stick is held, already dt-scaled. */
  onFly: (forward: number, right: number) => void;
  /** True while a pointer is down on the stick (for a render lease). */
  onActiveChange?: (active: boolean) => void;
  speed?: number;
}

/**
 * On-screen editor camera stick. Not the P9 game TouchJoystick — this only
 * flies the viewport camera.
 */
export function ViewportJoystick({
  onFly,
  onActiveChange,
  speed = DEFAULT_FLY_SPEED,
}: ViewportJoystickProps) {
  const baseRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<JoystickValue>({ x: 0, y: 0 });
  const onFlyRef = useRef(onFly);
  onFlyRef.current = onFly;
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const hasLastTimeRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const stopLoop = useCallback(() => {
    if (frameRef.current !== 0) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    hasLastTimeRef.current = false;
    lastTimeRef.current = 0;
  }, []);

  const tick = useCallback((time: number) => {
    frameRef.current = 0;
    let dt = 0;
    if (hasLastTimeRef.current) {
      dt = Math.min(0.05, Math.max(0, (time - lastTimeRef.current) / 1000));
    }
    lastTimeRef.current = time;
    hasLastTimeRef.current = true;
    const { x, y } = valueRef.current;
    if (x !== 0 || y !== 0) {
      onFlyRef.current(y * speedRef.current * dt, x * speedRef.current * dt);
    }
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const release = useCallback(() => {
    pointerIdRef.current = null;
    valueRef.current = { x: 0, y: 0 };
    setKnob({ x: 0, y: 0 });
    stopLoop();
    onActiveChangeRef.current?.(false);
  }, [stopLoop]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const base = baseRef.current;
    if (!base) return;
    pointerIdRef.current = event.pointerId;
    base.setPointerCapture(event.pointerId);
    const rect = base.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const value = joystickValueFromPointer(
      originX,
      originY,
      event.clientX,
      event.clientY,
      VIEWPORT_JOYSTICK_RADIUS,
    );
    valueRef.current = value;
    setKnob({ x: value.x, y: value.y });
    onActiveChangeRef.current?.(true);
    stopLoop();
    frameRef.current = requestAnimationFrame(tick);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const value = joystickValueFromPointer(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      event.clientX,
      event.clientY,
      VIEWPORT_JOYSTICK_RADIUS,
    );
    valueRef.current = value;
    setKnob({ x: value.x, y: value.y });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    release();
  };

  useEffect(() => () => release(), [release]);

  const knobOffsetX = knob.x * VIEWPORT_JOYSTICK_RADIUS;
  const knobOffsetY = -knob.y * VIEWPORT_JOYSTICK_RADIUS;

  return (
    <div
      ref={baseRef}
      className={cn(
        "relative size-24 touch-none rounded-full border border-border bg-card/80 shadow-md",
      )}
      data-testid="viewport-joystick"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="pointer-events-none absolute size-11 rounded-full border border-border bg-primary/80"
        style={{
          left: "50%",
          top: "50%",
          transform: `translate(calc(-50% + ${knobOffsetX}px), calc(-50% + ${knobOffsetY}px))`,
        }}
      />
    </div>
  );
}
