import { useCallback, useMemo, useRef } from "react";
import {
  describeUiControls,
  devicePresetForViewport,
  layoutUserInterface,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";
import { Button } from "@babylonslate/ui/components/button";
import { playJoystickAxesFromPointer } from "../lib/play-hud-joystick";

export interface PlayHudOverlayProps {
  instances?: ReadonlyArray<{
    instanceId: string;
    document: UserInterfaceDocument;
  }>;
  uiLibrary?: Record<string, UserInterfaceDocument>;
  width: number;
  height: number;
  hiddenWidgetIds?: ReadonlySet<string>;
  onTouchAxis: (controlId: string, value: number) => void;
}

function numberProp(
  props: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringProp(
  props: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = props[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

export function PlayHudOverlay({
  instances = [],
  uiLibrary = {},
  width,
  height,
  hiddenWidgetIds,
  onTouchAxis,
}: PlayHudOverlayProps) {
  const pointerIdRef = useRef<number | null>(null);
  const preset = useMemo(
    () => devicePresetForViewport(Math.max(1, width), Math.max(1, height)),
    [width, height],
  );
  const resolveNested = useCallback(
    (guid: string) => uiLibrary[guid] ?? null,
    [uiLibrary],
  );
  const controls = useMemo(() => {
    const viewport = { width: Math.max(1, width), height: Math.max(1, height) };
    return instances.flatMap((entry) => {
      const layout = layoutUserInterface(entry.document, viewport, {
        safeArea: preset.safeArea,
        resolveNested,
      });
      return describeUiControls(entry.document, layout, viewport.height).map(
        (control) => ({
          ...control,
          id: `${entry.instanceId}:${control.id}`,
        }),
      );
    });
  }, [instances, width, height, preset, resolveNested]);

  const emitStick = useCallback(
    (
      controlIdX: string,
      controlIdY: string,
      deadZone: number,
      clientX: number,
      clientY: number,
      bounds: DOMRect,
    ) => {
      const axes = playJoystickAxesFromPointer(clientX, clientY, bounds, deadZone);
      onTouchAxis(controlIdX, axes.x);
      onTouchAxis(controlIdY, axes.y);
    },
    [onTouchAxis],
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      data-testid="play-hud"
      data-preset={preset.id}
      data-safe-top={String(preset.safeArea.top)}
      data-safe-bottom={String(preset.safeArea.bottom)}
    >
      {controls.map((control) => {
        if (!control.visible) return null;
        if (hiddenWidgetIds?.has(control.id)) return null;
        const isStick = control.kind === "TouchJoystick";
        const deadZone = numberProp(control.props, "deadZone", 0.15);
        const controlIdX = stringProp(control.props, "controlIdX", "joystick-x");
        const controlIdY = stringProp(control.props, "controlIdY", "joystick-y");
        return (
          <Button
            key={control.id}
            type="button"
            variant="outline"
            data-testid={
              isStick ? "play-hud-stick" : `play-hud-widget-${control.id}`
            }
            data-kind={control.kind}
            data-gui-x={String(Math.round(control.guiRect.x))}
            data-gui-y={String(Math.round(control.guiRect.y))}
            className="pointer-events-auto absolute h-auto min-h-0 border-white/40 bg-black/35 px-0 py-0 text-[11px] text-white hover:bg-black/50"
            style={{
              left: control.guiRect.x,
              top: control.guiRect.y,
              width: Math.max(8, control.guiRect.width),
              height: Math.max(8, control.guiRect.height),
              borderRadius: isStick
                ? 999
                : (control.style.borderRadius ?? 6),
              fontFamily: control.style.fontFamily,
              color: control.style.color,
              background: control.style.background,
              opacity: control.style.opacity,
            }}
            onPointerDown={
              isStick
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pointerIdRef.current = event.pointerId;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    emitStick(
                      controlIdX,
                      controlIdY,
                      deadZone,
                      event.clientX,
                      event.clientY,
                      event.currentTarget.getBoundingClientRect(),
                    );
                  }
                : undefined
            }
            onPointerMove={
              isStick
                ? (event) => {
                    if (pointerIdRef.current !== event.pointerId) return;
                    emitStick(
                      controlIdX,
                      controlIdY,
                      deadZone,
                      event.clientX,
                      event.clientY,
                      event.currentTarget.getBoundingClientRect(),
                    );
                  }
                : undefined
            }
            onPointerUp={
              isStick
                ? (event) => {
                    if (pointerIdRef.current !== event.pointerId) return;
                    pointerIdRef.current = null;
                    onTouchAxis(controlIdX, 0);
                    onTouchAxis(controlIdY, 0);
                  }
                : undefined
            }
            onPointerCancel={
              isStick
                ? () => {
                    pointerIdRef.current = null;
                    onTouchAxis(controlIdX, 0);
                    onTouchAxis(controlIdY, 0);
                  }
                : undefined
            }
          >
            {control.text ?? control.name}
          </Button>
        );
      })}
    </div>
  );
}
