import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scene } from "@babylonjs/core/scene";
import {
  applyAdtIdeal,
  applyFontRegistryToHost,
  applyUiControls,
  attachFullscreenGui,
  FontRegistry,
  type FontAssetEntry,
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
import { parsePlayHudControlId } from "../lib/play-content";

export { parsePlayHudControlId };

const defaultResolveImageUrl = (): string | null => null;

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
  onWidgetEvent?: (event: {
    instanceId: string;
    widgetId: string;
    kind: "click" | "value" | "checked" | "text";
    value?: unknown;
  }) => void;
  /** Play scene; when set, widgets render through Babylon GUI. */
  scene?: Scene | null;
  fontEntries?: readonly FontAssetEntry[];
  resolveImageUrl?: (guid: string) => string | null;
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

const KIND_LABELS: Record<string, string> = {
  TouchJoystick: "Stick",
  TouchDPad: "D-Pad",
  TouchButton: "Button",
};

/** Visible HUD caption: authored text, else a player-facing kind label. */
export function playHudControlLabel(control: {
  kind: string;
  name?: string;
  text?: string;
}): string {
  const text = control.text?.trim();
  if (text) return text;
  const name = control.name?.trim();
  if (name && name !== control.kind) return name;
  return KIND_LABELS[control.kind] ?? name ?? "";
}

export function PlayHudOverlay({
  instances = [],
  uiLibrary = {},
  width,
  height,
  hiddenWidgetIds,
  onTouchAxis,
  onWidgetEvent,
  scene = null,
  fontEntries = [],
  resolveImageUrl = defaultResolveImageUrl,
}: PlayHudOverlayProps) {
  const pointerIdRef = useRef<number | null>(null);
  const onTouchAxisRef = useRef(onTouchAxis);
  onTouchAxisRef.current = onTouchAxis;
  const onWidgetEventRef = useRef(onWidgetEvent);
  onWidgetEventRef.current = onWidgetEvent;
  const resolveImageUrlRef = useRef(resolveImageUrl);
  resolveImageUrlRef.current = resolveImageUrl;
  const boundResolveImageUrl = useCallback(
    (guid: string) => resolveImageUrlRef.current(guid),
    [],
  );
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
      return describeUiControls(entry.document, layout).map(
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
      const first = instances[0]?.document;
      const attached = attachFullscreenGui(scene, {
        name: "play-hud",
        interactive: true,
        width: Math.max(1, width),
        height: Math.max(1, height),
        designResolution: first?.designResolution ?? {
          width: Math.max(1, width),
          height: Math.max(1, height),
        },
        scaleRule: first?.scaleRule ?? "shortestSide",
        safeArea: preset.safeArea,
        resolveImageUrl: boundResolveImageUrl,
        onTouchAxis: (controlId, value) => onTouchAxisRef.current(controlId, value),
        onWidgetEvent: (event) => {
          const parsed = parsePlayHudControlId(event.widgetId);
          if (!parsed) return;
          onWidgetEventRef.current?.({
            instanceId: parsed.instanceId,
            widgetId: parsed.widgetId,
            kind: event.kind,
            ...("value" in event ? { value: event.value } : {}),
          });
        },
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
  }, [scene, width, height, instances, preset.safeArea]);

  useEffect(() => {
    const attached = attachedRef.current;
    if (!attached) return;
    const first = instances[0]?.document;
    applyAdtIdeal(
      attached.adt,
      first?.designResolution ?? { width: Math.max(1, width), height: Math.max(1, height) },
      first?.scaleRule ?? "shortestSide",
    );
    applyUiControls(attached.host, visibleControls);
  }, [visibleControls, width, height, scene, instances, resolveImageUrl]);

  useEffect(() => {
    const attached = attachedRef.current;
    if (!attached || fontEntries.length === 0) return;
    const registry = new FontRegistry();
    void applyFontRegistryToHost(registry, fontEntries, () => {
      attached.adt.markAsDirty();
    });
  }, [fontEntries, guiReady, scene]);

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

  const emitWidget = useCallback(
    (
      controlId: string,
      kind: "click" | "value" | "checked" | "text",
      value?: unknown,
    ) => {
      const parsed = parsePlayHudControlId(controlId);
      if (!parsed) return;
      onWidgetEvent?.({
        instanceId: parsed.instanceId,
        widgetId: parsed.widgetId,
        kind,
        value,
      });
    },
    [onWidgetEvent],
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
        const isUiButton = control.kind === "Button";
        const isSlider = control.kind === "Slider";
        const isCheck = control.kind === "CheckBox";
        const isText = control.kind === "TextInput";
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
        const caption = playHudControlLabel(control);
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
              aria-label={isStick ? caption : undefined}
              className="pointer-events-none absolute flex items-end justify-center pb-2"
              style={boxStyle}
            >
              {isStick && caption ? (
                <span className="rounded-md bg-background/80 px-2 py-0.5 text-xs text-foreground">
                  {caption}
                </span>
              ) : null}
            </div>
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
            aria-label={isStick ? caption : undefined}
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
                        const clamped = Math.max(0, Math.min(1, t));
                        const min = numberProp(control.props, "min", 0);
                        const max = numberProp(control.props, "max", 1);
                        onTouchAxis(sliderId, Math.max(-1, Math.min(1, t * 2 - 1)));
                        emitWidget(
                          control.id,
                          "value",
                          min + clamped * (max - min),
                        );
                      }
                    : undefined
            }
            onClick={
              analog || isButton
                ? undefined
                : isUiButton
                  ? () => emitWidget(control.id, "click")
                  : isCheck
                    ? () =>
                        emitWidget(
                          control.id,
                          "checked",
                          !control.props.checked,
                        )
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
            {isText ? (
              <input
                className="h-full w-full bg-transparent px-1 text-[11px] outline-none"
                defaultValue={stringProp(control.props, "text", "")}
                onChange={(event) =>
                  emitWidget(control.id, "text", event.currentTarget.value)
                }
              />
            ) : (
              caption
            )}
          </Button>
        );
      })}
    </div>
  );
}
