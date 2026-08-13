import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scene } from "@babylonjs/core/scene";
import {
  applyAdtIdeal,
  applyUiControls,
  attachFullscreenGui,
} from "@babylonslate/render";
import {
  describeUiControls,
  devicePresetForViewport,
  layoutUserInterface,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";
import { Button } from "@babylonslate/ui/components/button";
import { useEngineUiDesignerPresets } from "../lib/engine-ui-presets";
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
  /** Play scene; when set, widgets render through Babylon GUI. */
  scene?: Scene | null;
}

function numberProp(
  props: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function capturePointer(target: EventTarget, pointerId: number): void {
  const capture = (target as { setPointerCapture?: (id: number) => void })
    .setPointerCapture;
  if (typeof capture === "function") capture.call(target, pointerId);
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
  scene = null,
}: PlayHudOverlayProps) {
  const pointerIdRef = useRef<number | null>(null);
  const onTouchAxisRef = useRef(onTouchAxis);
  onTouchAxisRef.current = onTouchAxis;
  const extras = useEngineUiDesignerPresets();
  const preset = useMemo(
    () =>
      devicePresetForViewport(Math.max(1, width), Math.max(1, height), extras),
    [width, height, extras],
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

  const visibleControls = useMemo(
    () =>
      controls.filter(
        (control) => control.visible && !hiddenWidgetIds?.has(control.id),
      ),
    [controls, hiddenWidgetIds],
  );

  const [guiReady, setGuiReady] = useState(false);
  const attachedRef = useRef<ReturnType<typeof attachFullscreenGui> | null>(
    null,
  );

  useEffect(() => {
    if (!scene) {
      attachedRef.current = null;
      setGuiReady(false);
      return;
    }
    try {
      const attached = attachFullscreenGui(scene, {
        name: "play-hud",
        interactive: true,
        width: Math.max(1, width),
        height: Math.max(1, height),
        onTouchAxis: (controlId, value) => onTouchAxisRef.current(controlId, value),
      });
      attachedRef.current = attached;
      setGuiReady(true);
      return () => {
        attached.dispose();
        attachedRef.current = null;
        setGuiReady(false);
      };
    } catch {
      attachedRef.current = null;
      setGuiReady(false);
    }
  }, [scene, width, height]);

  useEffect(() => {
    const attached = attachedRef.current;
    if (!attached) return;
    applyAdtIdeal(
      attached.adt,
      { width: Math.max(1, width), height: Math.max(1, height) },
      "shortestSide",
    );
    applyUiControls(attached.host, visibleControls);
  }, [visibleControls, width, height, scene]);

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

  const emitButton = useCallback(
    (action: string, down: boolean) => {
      onTouchAxis(action, down ? 1 : 0);
    },
    [onTouchAxis],
  );

  const useDomHits = !guiReady;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      data-testid="play-hud"
      data-preset={preset.id}
      data-safe-top={String(preset.safeArea.top)}
      data-safe-bottom={String(preset.safeArea.bottom)}
    >
      {visibleControls.map((control) => {
        const isStick = control.kind === "TouchJoystick";
        const isPad = control.kind === "TouchDPad";
        const isButton = control.kind === "TouchButton";
        const isSlider = control.kind === "Slider";
        const analog = isStick || isPad;
        const deadZone = numberProp(control.props, "deadZone", analog ? 0.15 : 0);
        const controlIdX = stringProp(
          control.props,
          "controlIdX",
          isPad ? "dpad-x" : "joystick-x",
        );
        const controlIdY = stringProp(
          control.props,
          "controlIdY",
          isPad ? "dpad-y" : "joystick-y",
        );
        const action = stringProp(control.props, "action", "Jump");
        const sliderId = stringProp(control.props, "controlId", "slider");
        const testId = isStick ? "play-hud-stick" : `play-hud-widget-${control.id}`;
        const boxStyle = {
          left: control.guiRect.x,
          top: control.guiRect.y,
          width: Math.max(8, control.guiRect.width),
          height: Math.max(8, control.guiRect.height),
        };
        if (!useDomHits) {
          return (
            <div
              key={control.id}
              data-testid={testId}
              data-kind={control.kind}
              data-gui-x={String(Math.round(control.guiRect.x))}
              data-gui-y={String(Math.round(control.guiRect.y))}
              className="absolute"
              style={boxStyle}
            />
          );
        }
        return (
          <Button
            key={control.id}
            type="button"
            variant="outline"
            data-testid={testId}
            data-kind={control.kind}
            data-gui-x={String(Math.round(control.guiRect.x))}
            data-gui-y={String(Math.round(control.guiRect.y))}
            className="pointer-events-auto absolute h-auto min-h-0 border-white/40 bg-black/35 px-0 py-0 text-[11px] text-white hover:bg-black/50"
            style={{
              ...boxStyle,
              borderRadius: isStick ? 999 : (control.style.borderRadius ?? 6),
              fontFamily: control.style.fontFamily,
              color: control.style.color,
              background: control.style.background,
              opacity: control.style.opacity,
            }}
            onPointerDown={
              analog
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pointerIdRef.current = event.pointerId;
                    capturePointer(event.currentTarget, event.pointerId);
                    emitStick(
                      controlIdX,
                      controlIdY,
                      deadZone,
                      event.clientX,
                      event.clientY,
                      event.currentTarget.getBoundingClientRect(),
                    );
                  }
                : isButton
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      pointerIdRef.current = event.pointerId;
                      capturePointer(event.currentTarget, event.pointerId);
                      emitButton(action, true);
                    }
                  : isSlider
                    ? (event) => {
                        event.preventDefault();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const t =
                          bounds.width > 0
                            ? (event.clientX - bounds.left) / bounds.width
                            : 0;
                        onTouchAxis(sliderId, Math.max(-1, Math.min(1, t * 2 - 1)));
                      }
                    : undefined
            }
            onPointerMove={
              analog
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
              analog
                ? (event) => {
                    if (pointerIdRef.current !== event.pointerId) return;
                    pointerIdRef.current = null;
                    onTouchAxis(controlIdX, 0);
                    onTouchAxis(controlIdY, 0);
                  }
                : isButton
                  ? () => {
                      pointerIdRef.current = null;
                      emitButton(action, false);
                    }
                  : undefined
            }
            onPointerCancel={
              analog
                ? () => {
                    pointerIdRef.current = null;
                    onTouchAxis(controlIdX, 0);
                    onTouchAxis(controlIdY, 0);
                  }
                : isButton
                  ? () => {
                      pointerIdRef.current = null;
                      emitButton(action, false);
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
