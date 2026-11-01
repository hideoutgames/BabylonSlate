import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Maximize2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { CURVE_EXTRAPOLATIONS, EASING_CURVE_LABELS, type CurveInterpolation } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import {
  CURVE_CHANNELS,
  INTERPOLATION_OPTIONS,
  channelPoints,
  clampKeyTimeTo,
  clampNumber,
  clampValue,
  curveValue,
  editorKeys,
  fitView,
  insertionTime,
  keyAt,
  roundTime,
  snapTime,
  zoomView,
  type CurveEditorConstraints,
  type CurveEditorKind,
  type CurveEditorValue,
  type CurveView,
  type EditorKey,
} from "./curve-editor-model";
import { NumericDragField } from "./numeric-drag-field";

export interface CurveEditorProps {
  kind: CurveEditorKind;
  value: CurveEditorValue;
  /**
   * Called once per finished drag (key, tangent or field scrub) and once per discrete action
   * (add, remove, nudge, menu choice), so each is one undo entry.
   */
  onChange: (next: ReturnType<typeof curveValue>) => void;
  "aria-label": string;
  constraints?: CurveEditorConstraints;
  /** Labels under the time axis; defaults to the visible start and end times. */
  axisLabels?: { start: string; end: string };
  /** Which channels show (Vector X, Y, Z; Color R, G, B, A); all by default. */
  channels?: readonly boolean[];
  onChannelsChange?: (channels: boolean[]) => void;
  disabled?: boolean;
  /** Prefix for the editor's test ids. */
  "data-testid"?: string;
}

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 6;
const TANGENT_LENGTH = 0.12;

type KeyDrag = { kind: "key"; pointerId: number; index: number; channel: number; moved: boolean };
type TangentDrag = { kind: "tangent"; pointerId: number; index: number; channel: number; side: "arrive" | "leave" };
type PanDrag = { kind: "pan"; pointerId: number; x: number; y: number; start: CurveView; moved: boolean };
type PinchDrag = { kind: "pinch"; start: CurveView; distance: number; fx: number; fy: number };
type Gesture = KeyDrag | TangentDrag | PanDrag | PinchDrag;

function interpolationLabel(value: CurveInterpolation): string {
  if (value === "constant") return "Constant";
  if (value === "linear") return "Linear";
  if (value === "auto") return "Auto";
  if (value === "custom") return "Custom";
  return EASING_CURVE_LABELS[value];
}

function formatAxis(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function cloneKeys(keys: readonly EditorKey[]): EditorKey[] {
  return keys.map((key) => ({ ...key, values: [...key.values], arrive: [...key.arrive], leave: [...key.leave] }));
}

/**
 * Curve plot with editable keys, shared by the Inspector curve rows, the Curve asset editor, particle
 * fields and the Timeline. Drag a key to move it (time and the dragged channel's value); arrows nudge
 * (Shift ×10); Delete removes; double-click empty space, or long-press it on touch and choose
 * **Add Key Here**, adds a key. Drag empty space to pan; pinch or Ctrl/Cmd-wheel zooms; **Fit** frames
 * the keys. A Custom key shows tangent handles. With `constraints`, the editor keeps a host's limits.
 */
export function CurveEditor({
  kind,
  value,
  onChange,
  "aria-label": ariaLabel,
  constraints = {},
  axisLabels,
  channels: controlledChannels,
  onChannelsChange,
  disabled = false,
  "data-testid": testId = "curve-editor",
}: CurveEditorProps) {
  const channelInfo = CURVE_CHANNELS[kind];
  const [channelState, setChannelState] = useState<boolean[]>(() => channelInfo.map(() => true));
  const visible = controlledChannels ?? channelState;
  const committed = editorKeys(kind, value);
  const [draft, setDraftState] = useState<EditorKey[] | null>(null);
  // Pointer events can arrive before React re-renders, so handlers read the latest draft from a ref.
  const draftRef = useRef<EditorKey[] | null>(null);
  const setDraft = (next: EditorKey[] | null) => { draftRef.current = next; setDraftState(next); };
  const keys = draft ?? committed;
  const [selected, setSelected] = useState<{ index: number; channel: number }>({ index: 0, channel: 0 });
  const [userView, setUserView] = useState<CurveView | null>(null);
  const [frozenView, setFrozenView] = useState<CurveView | null>(null);
  const [addHere, setAddHere] = useState<{ time: number; fx: number; fy: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const keyRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusKeyRef = useRef<string | null>(null);

  const view = userView ?? frozenView ?? fitView(kind, keys, visible, constraints);
  const curve = curveValue(kind, keys, value.Before, value.After);
  const last = keys.length - 1;
  const selectedIndex = clampNumber(selected.index, 0, Math.max(0, last));
  const selectedKey = keys[selectedIndex];
  const endpoint = !!constraints.lockEnds && (selectedIndex === 0 || selectedIndex === last);
  const minKeys = constraints.minKeys ?? 0;
  const maxKeys = constraints.maxKeys ?? Number.POSITIVE_INFINITY;
  const insertion = insertionTime(keys, constraints);
  const canAdd = !disabled && keys.length < maxKeys && insertion !== null;
  const canRemove = !disabled && !!selectedKey && !endpoint && keys.length > minKeys;
  const lockedInterpolation = constraints.interpolation;
  const spanT = view.t1 - view.t0;
  const spanV = view.v1 - view.v0;

  useEffect(() => {
    const id = focusKeyRef.current;
    if (id === null) return;
    focusKeyRef.current = null;
    keyRefs.current.get(id)?.focus();
  });

  useEffect(() => () => {
    if (longPressRef.current) clearTimeout(longPressRef.current);
  }, []);

  // Ctrl/Cmd-wheel zooms around the pointer; React's wheel listener cannot cancel the page scroll.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      setUserView((current) => zoomView(current ?? view, Math.exp(-event.deltaY * 0.002), fx, fy, !constraints.fixedTime));
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  });

  const emit = (next: readonly EditorKey[], before: unknown = value.Before, after: unknown = value.After) =>
    onChange(curveValue(kind, next, constraints.extrapolation ?? before, constraints.extrapolation ?? after));

  const fraction = (clientX: number, clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { fx: (clientX - rect.left) / rect.width, fy: (clientY - rect.top) / rect.height, rect };
  };
  const toData = (fx: number, fy: number) => ({ time: view.t0 + fx * spanT, value: view.v1 - fy * spanV });

  const moveKey = (source: readonly EditorKey[], index: number, channel: number, time: number, channelValue: number) => {
    const next = cloneKeys(source);
    const key = next[index]!;
    key.time = clampKeyTimeTo(next, index, time, constraints);
    key.values[channel] = clampValue(channelValue, constraints);
    return next;
  };

  const insertKey = (time: number) => {
    if (disabled || keys.length >= maxKeys) return;
    const t = roundTime(constraints.fixedTime ? clampNumber(time, 0, 1) : snapTime(time, constraints));
    const gap = constraints.keyGap ?? 0.001;
    if (keys.some((key) => Math.abs(key.time - t) < gap)) return;
    if (constraints.lockEnds && (t <= 0 || t >= 1)) return;
    const index = keys.findIndex((key) => key.time > t);
    const at = index < 0 ? keys.length : index;
    const next = cloneKeys(keys);
    next.splice(at, 0, keyAt(kind, keys, t, constraints));
    setSelected({ index: at, channel: selected.channel });
    emit(next);
  };

  const removeKey = (index: number) => {
    if (disabled || keys.length <= minKeys) return;
    if (constraints.lockEnds && (index === 0 || index === last)) return;
    setSelected({ index: Math.max(0, index - 1), channel: selected.channel });
    emit(keys.filter((_, keyIndex) => keyIndex !== index));
  };

  const endGesture = () => {
    gestureRef.current = null;
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };

  // Keys -------------------------------------------------------------------------------------------

  const onKeyPointerDown = (event: PointerEvent<HTMLButtonElement>, index: number, channel: number) => {
    event.stopPropagation();
    setAddHere(null);
    setSelected({ index, channel });
    if (disabled) return;
    gestureRef.current = { kind: "key", pointerId: event.pointerId, index, channel, moved: false };
    setFrozenView(view);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onHandlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || (gesture.kind !== "key" && gesture.kind !== "tangent") || gesture.pointerId !== event.pointerId) return;
    const point = fraction(event.clientX, event.clientY);
    if (!point) return;
    const source = draftRef.current ?? committed;
    if (gesture.kind === "key") {
      const data = toData(point.fx, point.fy);
      gesture.moved = true;
      setDraft(moveKey(source, gesture.index, gesture.channel, data.time, data.value));
      return;
    }
    const key = source[gesture.index]!;
    const kx = (key.time - view.t0) / spanT;
    const ky = (view.v1 - key.values[gesture.channel]!) / spanV;
    let dx = point.fx - kx;
    const dy = point.fy - ky;
    dx = gesture.side === "leave" ? Math.max(dx, 1e-3) : Math.min(dx, -1e-3);
    const slope = (-dy * spanV) / (dx * spanT);
    const next = cloneKeys(source);
    // One slope through the key keeps it smooth: both tangents follow the handle.
    next[gesture.index]!.arrive[gesture.channel] = slope;
    next[gesture.index]!.leave[gesture.channel] = slope;
    setDraft(next);
  };

  const onHandlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || (gesture.kind !== "key" && gesture.kind !== "tangent") || gesture.pointerId !== event.pointerId) return;
    endGesture();
    setFrozenView(null);
    const final = draftRef.current;
    setDraft(null);
    if (final && JSON.stringify(final) !== JSON.stringify(committed)) emit(final);
  };

  const onHandlePointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    if (gestureRef.current && "pointerId" in gestureRef.current && gestureRef.current.pointerId !== event.pointerId) return;
    endGesture();
    setFrozenView(null);
    setDraft(null);
  };

  const onKeyKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, channel: number) => {
    if (disabled) return;
    const key = keys[index]!;
    const large = event.shiftKey ? 10 : 1;
    const timeStep = (constraints.fixedTime ? 0.01 : spanT / 100) * large;
    const valueStep = (spanV / 100) * large;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        emit(moveKey(keys, index, channel, key.time + timeStep * (event.key === "ArrowLeft" ? -1 : 1), key.values[channel]!));
        break;
      case "ArrowUp":
      case "ArrowDown":
        emit(moveKey(keys, index, channel, key.time, key.values[channel]! + valueStep * (event.key === "ArrowDown" ? -1 : 1)));
        break;
      case "Delete":
      case "Backspace":
        if (keys.length > minKeys && !(constraints.lockEnds && (index === 0 || index === last))) {
          focusKeyRef.current = `${Math.max(0, index - 1)}:${channel}`;
          removeKey(index);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // Empty space: pan, pinch, long-press ------------------------------------------------------------

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    setAddHere(null);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointers = [...pointersRef.current.values()];
    if (pointers.length >= 2) {
      endGesture();
      const [a, b] = pointers as [{ x: number; y: number }, { x: number; y: number }];
      const mid = fraction((a.x + b.x) / 2, (a.y + b.y) / 2);
      gestureRef.current = { kind: "pinch", start: view, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, fx: mid?.fx ?? 0.5, fy: mid?.fy ?? 0.5 };
      return;
    }
    gestureRef.current = { kind: "pan", pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: view, moved: false };
    if (event.pointerType !== "mouse" && !disabled && keys.length < maxKeys) {
      const at = fraction(event.clientX, event.clientY);
      longPressRef.current = setTimeout(() => {
        longPressRef.current = null;
        const gesture = gestureRef.current;
        if (!at || gesture?.kind !== "pan" || gesture.moved) return;
        setAddHere({ time: toData(at.fx, at.fy).time, fx: at.fx, fy: at.fy });
      }, LONG_PRESS_MS);
    }
  };

  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!gesture || !rect || rect.width <= 0 || rect.height <= 0) return;
    if (gesture.kind === "pinch") {
      const [a, b] = [...pointersRef.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      if (!b) return;
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance;
      setUserView(zoomView(gesture.start, factor, gesture.fx, gesture.fy, !constraints.fixedTime));
      return;
    }
    if (gesture.kind !== "pan" || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < MOVE_TOLERANCE_PX) return;
    gesture.moved = true;
    const dt = constraints.fixedTime ? 0 : (-dx / rect.width) * (gesture.start.t1 - gesture.start.t0);
    const dv = (dy / rect.height) * (gesture.start.v1 - gesture.start.v0);
    setUserView({ t0: gesture.start.t0 + dt, t1: gesture.start.t1 + dt, v0: gesture.start.v0 + dv, v1: gesture.start.v1 + dv });
  };

  const onTrackPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) endGesture();
  };

  const onTrackDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    const point = fraction(event.clientX, event.clientY);
    if (point) insertKey(toData(point.fx, point.fy).time);
  };

  // Selected key fields: live drafts, one change when the scrub or typed edit ends --------------------

  const editSelected = (change: (key: EditorKey, next: EditorKey[]) => void, commit: boolean) => {
    const next = cloneKeys(draftRef.current ?? committed);
    const key = next[selectedIndex];
    if (!key) return;
    change(key, next);
    if (commit) {
      setDraft(null);
      emit(next);
    } else {
      setDraft(next);
    }
  };

  const setInterpolation = (interpolation: CurveInterpolation) => {
    if (!selectedKey) return;
    const next = cloneKeys(keys);
    next[selectedIndex]!.interpolation = interpolation;
    emit(next);
  };

  const keyId = (index: number, channel: number) =>
    channelInfo.length === 1 ? `${testId}-key-${index}` : `${testId}-key-${index}-${channelInfo[channel]!.key}`;
  const hitFraction = (index: number) => {
    const left = index > 0 ? (keys[index]!.time - keys[index - 1]!.time) / spanT : 1;
    const right = index < last ? (keys[index + 1]!.time - keys[index]!.time) / spanT : 1;
    return Math.max(0, Math.min(left, right, 1));
  };
  const showTangents = !lockedInterpolation && selectedKey?.interpolation === "custom" && !disabled;
  const visibleChannels = channelInfo.map((_, index) => index).filter((index) => visible[index] !== false);
  const timeLabels = axisLabels ?? { start: formatAxis(view.t0), end: formatAxis(view.t1) };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1">
        {channelInfo.length > 1 ? (
          <ToggleGroup
            multiple
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={`${ariaLabel} Channels`}
            value={channelInfo.map((channel, index) => (visible[index] !== false ? channel.label : null)).filter((entry): entry is string => !!entry)}
            onValueChange={(labels) => {
              const next = channelInfo.map((channel) => (labels as string[]).includes(channel.label));
              if (!next.some(Boolean)) return;
              if (!controlledChannels) setChannelState(next);
              onChannelsChange?.(next);
            }}
          >
            {channelInfo.map((channel) => (
              <ToggleGroupItem
                key={channel.label}
                value={channel.label}
                aria-label={`Show ${channel.label}`}
                className={cn("pointer-coarse:min-h-11", channel.accent && `text-axis-${channel.accent}`)}
                data-testid={`${testId}-channel-${channel.label}`}
              >
                {channel.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <Button type="button" variant="outline" size="xs" className="pointer-coarse:min-h-11" disabled={!canAdd}
          onClick={() => { if (insertion) insertKey(insertion.time); }} data-testid={`${testId}-add`}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add Key
        </Button>
        <Button type="button" variant="outline" size="xs" className="pointer-coarse:min-h-11" disabled={!canRemove}
          onClick={() => removeKey(selectedIndex)} data-testid={`${testId}-remove`}>
          <Trash2Icon data-icon="inline-start" aria-hidden="true" />
          Remove Key
        </Button>
        <Button type="button" variant="ghost" size="xs" className="ml-auto pointer-coarse:min-h-11"
          disabled={!userView} onClick={() => setUserView(null)} data-testid={`${testId}-fit`}>
          <Maximize2Icon data-icon="inline-start" aria-hidden="true" />
          Fit
        </Button>
      </div>
      <div
        className="relative isolate h-[150px] touch-none overflow-hidden rounded-md border border-input bg-control pointer-coarse:h-[200px]"
        data-testid={`${testId}-plot`}
      >
        <span className="pointer-events-none absolute top-0.5 left-1 text-[10px] tabular-nums text-muted-foreground">{formatAxis(view.v1)}</span>
        <span className="pointer-events-none absolute bottom-0.5 left-1 text-[10px] tabular-nums text-muted-foreground">{formatAxis(view.v0)}</span>
        <div
          ref={trackRef}
          role="group"
          aria-label={`${ariaLabel} Curve Keys`}
          className="absolute inset-3.5 pointer-coarse:inset-[22px]"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          onPointerCancel={onTrackPointerUp}
          onDoubleClick={onTrackDoubleClick}
          data-testid={`${testId}-track`}
        >
          <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {[0, 50, 100].map((y) => (
              <line key={y} x1={0} x2={100} y1={y} y2={y} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {visibleChannels.map((channel) => (
              <polyline
                key={channel}
                className="fill-none"
                style={{ stroke: channelInfo[channel]!.stroke }}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                points={channelPoints(kind, curve, channel, view)}
              />
            ))}
            {showTangents && selectedKey ? (() => {
              const channel = visible[selected.channel] !== false ? selected.channel : visibleChannels[0] ?? 0;
              const kx = ((selectedKey.time - view.t0) / spanT) * 100;
              const ky = ((view.v1 - selectedKey.values[channel]!) / spanV) * 100;
              const [ux, uy] = tangentDirection(selectedKey.leave[channel]!, spanT, spanV);
              return <line x1={kx - ux * TANGENT_LENGTH * 100} y1={ky - uy * TANGENT_LENGTH * 100} x2={kx + ux * TANGENT_LENGTH * 100} y2={ky + uy * TANGENT_LENGTH * 100}
                className="stroke-muted-foreground" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
            })() : null}
          </svg>
          {keys.flatMap((key, index) => visibleChannels.map((channel) => {
            const fx = (key.time - view.t0) / spanT;
            const rawFy = (view.v1 - key.values[channel]!) / spanV;
            const fy = constraints.fixedTime ? clampNumber(rawFy, 0, 1) : rawFy;
            if (fx < -0.02 || fx > 1.02 || fy < -0.02 || fy > 1.02) return [];
            const isSelected = index === selectedIndex && (channelInfo.length === 1 || channel === selected.channel);
            const id = keyId(index, channel);
            const label = channelInfo.length === 1
              ? `Key ${index + 1}, Time ${key.time.toFixed(2)}, Value ${key.values[0]!.toFixed(2)}`
              : `Key ${index + 1} ${channelInfo[channel]!.label}, Time ${key.time.toFixed(2)}, Value ${key.values[channel]!.toFixed(2)}`;
            return [
              // Raw handles: Button primitives grow to 44×44 in touch rows; these cap at the gap to their neighbours.
              <button
                key={`${index}:${channel}`}
                ref={(element) => { keyRefs.current.set(`${index}:${channel}`, element); }}
                type="button"
                className={cn(
                  "absolute flex size-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-[min(44px,var(--curve-key-hit))]",
                  isSelected && "z-10",
                )}
                style={{ left: `${fx * 100}%`, top: `${fy * 100}%`, "--curve-key-hit": `${hitFraction(index) * 100}%` } as CSSProperties}
                aria-label={label}
                aria-pressed={isSelected}
                disabled={disabled}
                onPointerDown={(event) => onKeyPointerDown(event, index, channel)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandlePointerCancel}
                onFocus={() => setSelected({ index, channel })}
                onKeyDown={(event) => onKeyKeyDown(event, index, channel)}
                data-testid={id}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-2.5 rounded-full border-2", isSelected ? "ring-2 ring-ring/50" : "bg-background")}
                  style={{ borderColor: isSelected ? "var(--primary)" : channelInfo[channel]!.stroke, ...(isSelected ? { background: "var(--primary)" } : {}) }}
                />
              </button>,
            ];
          }))}
          {showTangents && selectedKey ? (["arrive", "leave"] as const).map((side) => {
            const channel = visible[selected.channel] !== false ? selected.channel : visibleChannels[0] ?? 0;
            const slope = side === "leave" ? selectedKey.leave[channel]! : selectedKey.arrive[channel]!;
            const [ux, uy] = tangentDirection(slope, spanT, spanV);
            const sign = side === "leave" ? 1 : -1;
            const fx = (selectedKey.time - view.t0) / spanT + sign * ux * TANGENT_LENGTH;
            const fy = (view.v1 - selectedKey.values[channel]!) / spanV + sign * uy * TANGENT_LENGTH;
            return (
              <button
                key={side}
                type="button"
                className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11"
                style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
                aria-label={`${side === "leave" ? "Leave" : "Arrive"} Tangent`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  gestureRef.current = { kind: "tangent", pointerId: event.pointerId, index: selectedIndex, channel, side };
                  setFrozenView(view);
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandlePointerCancel}
                data-testid={`${testId}-tangent-${side}`}
              >
                <span aria-hidden="true" className="size-2 rotate-45 border border-foreground bg-background" />
              </button>
            );
          }) : null}
          {addHere ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="absolute z-20 -translate-x-1/2 -translate-y-full pointer-coarse:min-h-11"
              style={{ left: `${clampNumber(addHere.fx, 0.1, 0.9) * 100}%`, top: `${clampNumber(addHere.fy, 0.2, 1) * 100}%` }}
              onClick={() => { insertKey(addHere.time); setAddHere(null); }}
              data-testid={`${testId}-add-here`}
            >
              Add Key Here
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span data-testid={`${testId}-time-start`}>{timeLabels.start}</span>
        <span data-testid={`${testId}-time-end`}>{timeLabels.end}</span>
      </div>
      {selectedKey ? (
        <div className="grid grid-cols-2 gap-1">
          <div className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">Time</span>
            <div className="min-w-0 flex-1">
              <NumericDragField
                aria-label={`${ariaLabel} Key ${selectedIndex + 1} Time`}
                value={selectedKey.time}
                min={constraints.fixedTime ? 0 : constraints.timeRange?.[0]}
                max={constraints.fixedTime ? 1 : constraints.timeRange?.[1]}
                sensitivity={constraints.fixedTime ? 0.005 : spanT / 200}
                disabled={disabled || endpoint}
                onChange={(time) => editSelected((key, next) => { key.time = clampKeyTimeTo(next, selectedIndex, time, constraints); }, false)}
                onDragEnd={(time) => editSelected((key, next) => { key.time = clampKeyTimeTo(next, selectedIndex, time, constraints); }, true)}
                data-testid={`${testId}-time`}
              />
            </div>
          </div>
          {channelInfo.map((channel, index) => (
            <div key={channel.label} className="flex min-w-0 items-center gap-1">
              <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">{channelInfo.length === 1 ? "Value" : channel.label}</span>
              <div className="min-w-0 flex-1">
                <NumericDragField
                  aria-label={`${ariaLabel} Key ${selectedIndex + 1} ${channelInfo.length === 1 ? "Value" : channel.label}`}
                  value={selectedKey.values[index]!}
                  min={constraints.valueMin}
                  max={constraints.valueMax}
                  accent={channel.accent}
                  sensitivity={spanV / 200}
                  disabled={disabled}
                  onChange={(next) => editSelected((key) => { key.values[index] = clampValue(next, constraints); }, false)}
                  onDragEnd={(next) => editSelected((key) => { key.values[index] = clampValue(next, constraints); }, true)}
                  data-testid={channelInfo.length === 1 ? `${testId}-value` : `${testId}-value-${channel.label}`}
                />
              </div>
            </div>
          ))}
          {lockedInterpolation ? null : (
            <EnumSelect
              label="Interpolation"
              aria-label={`${ariaLabel} Key ${selectedIndex + 1} Interpolation`}
              value={selectedKey.interpolation}
              options={INTERPOLATION_OPTIONS.map((option) => ({ value: option, label: interpolationLabel(option) }))}
              disabled={disabled}
              onChange={(next) => setInterpolation(next as CurveInterpolation)}
              data-testid={`${testId}-interpolation`}
            />
          )}
        </div>
      ) : null}
      {constraints.fixedTime || constraints.extrapolation ? null : (
        <div className="grid grid-cols-2 gap-1">
          {(["Before", "After"] as const).map((end) => (
            <EnumSelect
              key={end}
              label={end}
              aria-label={`${ariaLabel} ${end}`}
              value={String((end === "Before" ? curve.Before : curve.After))}
              options={CURVE_EXTRAPOLATIONS.map((option) => ({ value: option, label: option[0]!.toUpperCase() + option.slice(1) }))}
              disabled={disabled}
              onChange={(next) => emit(keys, end === "Before" ? next : curve.Before, end === "After" ? next : curve.After)}
              data-testid={`${testId}-${end.toLowerCase()}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Unit direction (in the plot's 0–1 space, y down) of a slope in value per second. */
function tangentDirection(slope: number, spanT: number, spanV: number): [number, number] {
  const dx = 1 / spanT;
  const dy = -slope / spanV;
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

function EnumSelect({ label, "aria-label": ariaLabel, value, options, disabled, onChange, "data-testid": testId }: {
  label: string;
  "aria-label": string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
  "data-testid"?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <Select value={value} disabled={disabled} onValueChange={(next) => { if (next != null) onChange(String(next)); }}>
        <SelectTrigger aria-label={ariaLabel} size="sm" className="min-w-0 flex-1 pointer-coarse:min-h-11" data-testid={testId}>
          <SelectValue>{(current: unknown) => options.find((option) => option.value === current)?.label ?? String(current ?? "")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
