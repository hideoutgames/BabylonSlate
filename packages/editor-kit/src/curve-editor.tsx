import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, Maximize2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { CURVE_EXTRAPOLATIONS, EASING_CURVE_LABELS, MIN_CURVE_KEY_GAP, type CurveExtrapolation, type CurveInterpolation } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { Separator } from "@haptic/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import { ColorField } from "./color-field";
import {
  CURVE_CHANNELS,
  INTERPOLATION_OPTIONS,
  allAxes,
  channelPoints,
  clampNumber,
  clampValue,
  curveValue,
  editorKeys,
  fitView,
  holdsAxis,
  insertionTime,
  keyAt,
  keyTangent,
  roundTime,
  rulerTicks,
  sampleChannel,
  snapTime,
  withCustomTangents,
  zoomView,
  type CurveEditorConstraints,
  type CurveEditorKind,
  type CurveEditorValue,
  type CurveView,
  type EditorKey,
} from "./curve-editor-model";
import { gradientBackground, type Rgba } from "./gradient-colors";
import { NumericDragField } from "./numeric-drag-field";
import { ShortcutKeys } from "./shortcut-keys";
import { useTouchUi } from "./touch-ui";

/** Imperative controls a host binds to its own shortcuts (the Curve asset window's Frame Selection). */
export interface CurveEditorHandle {
  /** Frames every visible key, as **Fit** does. */
  fit: () => void;
}

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
  /** Labels on the time ruler's ends in place of its numbers (a particle's Birth and Death). */
  axisLabels?: { start: string; end: string };
  /** Which channels show (Vector X, Y, Z; Color R, G, B, A); all by default. */
  channels?: readonly boolean[];
  onChannelsChange?: (channels: boolean[]) => void;
  disabled?: boolean;
  /**
   * `inline` (default): a compact plot with the key fields and Before/After below it, for Inspector rows,
   * particle fields and the Timeline. `window`: fills its host with a toolbar, the plot and one key bar;
   * a Color Curve adds a gradient lane whose stops are the keys. The host edits Before and After.
   */
  layout?: "inline" | "window";
  /** Chord shown on the window layout's **Fit** button; the host binds it. */
  fitShortcut?: string;
  ref?: Ref<CurveEditorHandle>;
  /** Prefix for the editor's test ids. */
  "data-testid"?: string;
}

const LONG_PRESS_MS = 500;
/** Finger movement that starts a drag (and cancels a hold). */
const MOVE_TOLERANCE_PX = 6;
/** Mouse movement that turns a press into a drag or a selection box. */
const MOUSE_SLOP_PX = 3;
/** Tangent handle reach when the plot has not been measured, as a share of the plot. */
const TANGENT_LENGTH = 0.12;
const VALUE_RULER_WIDTH = 40;
/** Key span shown past each end in the window layout, where the extrapolated curve is hatched. */
const WINDOW_TIME_PAD = 0.12;
/** Narrowest extrapolated range that shows its Before / After label. */
const ZONE_LABEL_MIN_PX = 88;
const HATCH = "bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_6px)] opacity-70";

/** One key's handle on one channel (Float: always channel 0). */
type KeyHandle = { index: number; channel: number };
type SelectMode = "replace" | "add" | "toggle";
/** Moves every handle in `handles` by the pointer's change since it pressed `primary`. */
type KeyDrag = {
  kind: "key"; pointerId: number; handles: KeyHandle[]; primary: KeyHandle; timeOnly: boolean;
  x: number; y: number; startTime: number; startValue: number; moved: boolean;
  /** Pressed a key of a group without modifiers: a click without a drag selects it alone. */
  collapse: boolean;
};
type TangentDrag = { kind: "tangent"; pointerId: number; index: number; channel: number; side: "arrive" | "leave" };
/** A finger or right-drag on empty space; `held` once a finger stayed still for a long press. */
type PanDrag = {
  kind: "pan"; pointerId: number; x: number; y: number; start: CurveView; moved: boolean;
  held: boolean; menu: boolean; fx: number; fy: number;
};
type PinchDrag = { kind: "pinch"; start: CurveView; distance: number; fx: number; fy: number };
type MarqueeDrag = {
  kind: "marquee"; pointerId: number; x: number; y: number; fx: number; fy: number;
  mode: SelectMode; base: KeyHandle[]; active: boolean;
};
type Gesture = KeyDrag | TangentDrag | PanDrag | PinchDrag | MarqueeDrag;

function selectModeOf(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  return event.shiftKey ? "add" : event.ctrlKey || event.metaKey ? "toggle" : "replace";
}

const EXTRAPOLATION_LABELS: Record<CurveExtrapolation, string> = {
  constant: "Constant", linear: "Linear", cycle: "Cycle", oscillate: "Oscillate",
};

function interpolationLabel(value: CurveInterpolation): string {
  if (value === "constant") return "Constant";
  if (value === "linear") return "Linear";
  if (value === "auto") return "Auto";
  if (value === "custom") return "Custom";
  return EASING_CURVE_LABELS[value];
}

const BASIC_INTERPOLATIONS: readonly CurveInterpolation[] = ["constant", "linear", "auto", "custom"];
const EASE_INTERPOLATIONS = INTERPOLATION_OPTIONS.filter((option) => !BASIC_INTERPOLATIONS.includes(option));

function cloneKeys(keys: readonly EditorKey[]): EditorKey[] {
  return keys.map((key) => ({ ...key, values: [...key.values], arrive: [...key.arrive], leave: [...key.leave] }));
}

/** A key while an edit reorders, splits or merges keys: `origins` are the indices it came from (-1 for a new key). */
type TrackedKey = EditorKey & { origins: number[] };

function untrack(key: TrackedKey): EditorKey {
  return { time: key.time, values: key.values, interpolation: key.interpolation, arrive: key.arrive, leave: key.leave, axes: key.axes };
}

/** Offset (in plot fractions, y down) from a key to its handle on `slope`, `length` px long once the plot is measured. */
function tangentOffset(slope: number, view: CurveView, width: number, height: number, length: number): [number, number] {
  const spanT = view.t1 - view.t0;
  const spanV = view.v1 - view.v0;
  if (width > 0 && height > 0) {
    const dx = width / spanT;
    const dy = (-slope * height) / spanV;
    const size = Math.hypot(dx, dy) || 1;
    return [((dx / size) * length) / width, ((dy / size) * length) / height];
  }
  const dx = 1 / spanT;
  const dy = -slope / spanV;
  const size = Math.hypot(dx, dy) || 1;
  return [(dx / size) * TANGENT_LENGTH, (dy / size) * TANGENT_LENGTH];
}

/**
 * Curve plot with editable keys, shared by the Inspector curve rows, the Curve asset editor, particle
 * fields and the Timeline. A time ruler and a value ruler frame the plot; the time outside the keys is
 * hatched and its extrapolated curve dashed. Drag a key to move it (time and the dragged channel's value);
 * arrows nudge (Shift ×10); Delete removes; double-click empty space, or long-press it on touch and choose
 * **Add Key Here**, adds a key. Drag empty space to pan; pinch or Ctrl/Cmd-wheel zooms. Edits keep the view;
 * **Fit** frames the keys. Auto and Custom keys show tangent handles; dragging an Auto handle makes the key
 * Custom. Hovering with a mouse reads out each channel. With `constraints`, the editor keeps a host's limits.
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
  layout = "inline",
  fitShortcut,
  ref,
  "data-testid": testId = "curve-editor",
}: CurveEditorProps) {
  const isWindow = layout === "window";
  const touch = useTouchUi();
  const inset = touch ? 22 : 14;
  const channelInfo = CURVE_CHANNELS[kind];
  const multi = channelInfo.length > 1;
  const [channelState, setChannelState] = useState<boolean[]>(() => channelInfo.map(() => true));
  const visible = controlledChannels ?? channelState;
  const visibleChannels = channelInfo.map((_, index) => index).filter((index) => visible[index] !== false);
  // Vector keys may set only some axes, so each axis has its own keys; Timeline tracks keep every axis together.
  const independent = kind === "vec3" && !constraints.sharedKeys;
  const committed = editorKeys(kind, value);
  const [draft, setDraftState] = useState<EditorKey[] | null>(null);
  // Pointer events can arrive before React re-renders, so handlers read the latest draft from a ref.
  const draftRef = useRef<EditorKey[] | null>(null);
  const setDraft = (next: EditorKey[] | null) => { draftRef.current = next; setDraftState(next); };
  const keys = draft ?? committed;
  // Selected key handles, the last one primary (its tangents show and the key bar reads it). Focus events
  // arrive before React re-renders, so they read the latest selection from the ref.
  const [selectionState, setSelectionState] = useState<KeyHandle[]>([{ index: 0, channel: 0 }]);
  const selectionRef = useRef<KeyHandle[]>(selectionState);
  const select = (next: KeyHandle[]) => { selectionRef.current = next; setSelectionState(next); };
  const [userView, setUserView] = useState<CurveView | null>(null);
  const [frozenView, setFrozenView] = useState<CurveView | null>(null);
  const [addHere, setAddHere] = useState<{ time: number; fx: number; fy: number } | null>(null);
  const [hover, setHover] = useState<{ fx: number; fy: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const keyRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusKeyRef = useRef<string | null>(null);
  // A key pressed with a pointer has its selection settled already; its focus event must not replace it.
  const pointerSelectRef = useRef(false);
  // A Time scrub moves the keys selected when it began, from the committed curve.
  const timeBaseRef = useRef<KeyHandle[] | null>(null);

  const view = userView ?? frozenView ?? fitView(kind, keys, visible, constraints, isWindow ? WINDOW_TIME_PAD : undefined);
  const curve = curveValue(kind, keys, value.Before, value.After);
  const last = keys.length - 1;
  const selection = selectionState.filter((handle) => handle.index >= 0 && handle.index <= last);
  const primary = selection[selection.length - 1];
  const selectedIndex = primary?.index ?? -1;
  const selectedKey = primary ? keys[primary.index] : undefined;
  const selectedIndices = [...new Set(selection.map((handle) => handle.index))].sort((a, b) => a - b);
  const multiKeys = selectedIndices.length > 1;
  const locked = (index: number) => !!constraints.lockEnds && (index === 0 || index === last);
  const minKeys = constraints.minKeys ?? 0;
  const maxKeys = constraints.maxKeys ?? Number.POSITIVE_INFINITY;
  const insertion = insertionTime(keys, constraints);
  const canAdd = !disabled && keys.length < maxKeys && insertion !== null;
  const removable = selectedIndices.filter((index) => !locked(index));
  const canRemove = !disabled && (independent ? selection.length > 0 : removable.length > 0 && keys.length > minKeys);
  const timeLocked = selectedIndices.some(locked);
  const lockedInterpolation = constraints.interpolation;
  const spanT = view.t1 - view.t0;
  const spanV = view.v1 - view.v0;
  const trackWidth = Math.max(0, size.width - inset * 2);
  const trackHeight = Math.max(0, size.height - inset * 2);
  const showLane = isWindow && kind === "color";

  useImperativeHandle(ref, () => ({ fit: () => setUserView(null) }), []);

  useEffect(() => {
    const id = focusKeyRef.current;
    if (id === null) return;
    focusKeyRef.current = null;
    keyRefs.current.get(id)?.focus();
  });

  useEffect(() => () => {
    if (longPressRef.current) clearTimeout(longPressRef.current);
  }, []);

  // The plot's pixel size places the rulers' ticks and keeps tangent handles a fixed distance from their key.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setSize((current) => (current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
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

  // Every edit keeps the view it was made in; only Fit (or a pan or zoom) moves it.
  const emit = (next: readonly EditorKey[], before: unknown = value.Before, after: unknown = value.After) => {
    if (!userView) setUserView(view);
    onChange(curveValue(kind, next, constraints.extrapolation ?? before, constraints.extrapolation ?? after));
  };

  const fraction = (clientX: number, clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { fx: (clientX - rect.left) / rect.width, fy: (clientY - rect.top) / rect.height, rect };
  };
  const toData = (fx: number, fy: number) => ({ time: view.t0 + fx * spanT, value: view.v1 - fy * spanV });
  const fxOf = (time: number) => (time - view.t0) / spanT;
  const fyOf = (channelValue: number) => (view.v1 - channelValue) / spanV;
  /** Where a key's handle draws: a fixed time axis keeps it inside the plot. */
  const handleFy = (key: EditorKey, channel: number) => {
    const fy = fyOf(key.values[channel]!);
    return constraints.fixedTime ? clampNumber(fy, 0, 1) : fy;
  };

  // Selection ---------------------------------------------------------------------------------------

  const sameHandle = (a: KeyHandle, b: KeyHandle) => a.index === b.index && (!multi || a.channel === b.channel);
  const isSelectedHandle = (index: number, channel: number) => selection.some((handle) => sameHandle(handle, { index, channel }));
  /** `base` with `handles` in its place, added, or toggled; the last handle becomes primary. */
  const combine = (base: readonly KeyHandle[], handles: readonly KeyHandle[], mode: SelectMode): KeyHandle[] => {
    if (mode === "replace") return [...handles];
    const kept = base.filter((handle) => !handles.some((other) => sameHandle(handle, other)));
    if (mode === "add") return [...kept, ...handles];
    return [...kept, ...handles.filter((handle) => !base.some((other) => sameHandle(handle, other)))];
  };
  const fallbackChannel = () => primary?.channel ?? visibleChannels[0] ?? 0;

  /**
   * `source` with the keys of `handles` moved `dt` seconds together and each handle's channel moved by `dv`.
   * A key moves only as far as the unselected keys that set one of its axes allow, and stays inside the time
   * range and off locked ends. With independent axes a Vector key whose selected axes are fewer than its own
   * splits when it moves in time (or with `split`): the selected axes become their own key. `change` edits
   * each moved key; then keys of other axes that meet with the same interpolation merge into one. `remap`
   * finds a handle's key in the result.
   */
  const shiftKeys = (
    source: readonly EditorKey[], handles: readonly KeyHandle[], dt: number, dv: number | null,
    options: { split?: boolean; change?: (key: EditorKey, origin: number) => void } = {},
  ): { keys: EditorKey[]; remap: (handle: KeyHandle) => KeyHandle } => {
    const next: TrackedKey[] = cloneKeys(source).map((key, index) => ({ ...key, origins: [index] }));
    const masks = new Map<number, number>();
    for (const handle of handles) {
      if (handle.index < 0 || handle.index >= source.length) continue;
      masks.set(handle.index, (masks.get(handle.index) ?? 0) | (independent ? 1 << handle.channel : allAxes(kind)));
    }
    const moving = new Set<TrackedKey>();
    const movingByOrigin = new Map<number, TrackedKey>();
    for (const [index, mask] of masks) {
      const key = next[index]!;
      const axes = mask & key.axes;
      let moved = key;
      if (independent && axes !== 0 && axes !== key.axes && (dt !== 0 || options.split)) {
        moved = { ...cloneKeys([key])[0]!, axes, origins: [index] };
        key.axes &= ~axes;
        next.push(moved);
      }
      moving.add(moved);
      movingByOrigin.set(index, moved);
    }
    const gap = constraints.keyGap ?? MIN_CURVE_KEY_GAP;
    const range = constraints.fixedTime ? ([0, 1] as const) : constraints.timeRange;
    let low = 0;
    let high = 0;
    if (dt !== 0) {
      low = Number.NEGATIVE_INFINITY;
      high = Number.POSITIVE_INFINITY;
      for (const key of moving) {
        const origin = key.origins[0]!;
        if (constraints.lockEnds && (origin === 0 || origin === source.length - 1)) { low = 0; high = 0; }
        for (const other of next) {
          if (moving.has(other) || (other.axes & key.axes) === 0) continue;
          if (other.time < key.time || (other.time === key.time && other.origins[0]! < origin)) low = Math.max(low, other.time + gap - key.time);
          else high = Math.min(high, other.time - gap - key.time);
        }
        if (range) { low = Math.max(low, range[0] - key.time); high = Math.min(high, range[1] - key.time); }
      }
      // Never forced to move: keys already closer than the gap may stay where they are.
      low = Math.min(low, 0);
      high = Math.max(high, 0);
    }
    const shift = clampNumber(dt, low, high);
    for (const key of moving) key.time = roundTime(key.time + shift);
    if (dv !== null) {
      for (const handle of handles) {
        const key = movingByOrigin.get(handle.index);
        if (key && holdsAxis(key, handle.channel)) {
          key.values[handle.channel] = clampValue(source[handle.index]!.values[handle.channel]! + dv, constraints);
        }
      }
    }
    if (options.change) for (const key of moving) options.change(key, key.origins[0]!);
    // Time order; a key that split off sorts after the key it left at the same time.
    next.sort((x, y) => x.time - y.time || x.origins[0]! - y.origins[0]! || Number(moving.has(x)) - Number(moving.has(y)));
    const result = independent ? mergeMeetingKeys(next) : next;
    return {
      keys: result.map(untrack),
      remap: (handle) => {
        const at = result.findIndex((key) => key.origins.includes(handle.index) && holdsAxis(key, handle.channel));
        return { index: at < 0 ? handle.index : at, channel: handle.channel };
      },
    };
  };
  /** Vector keys of other axes that meet within the key gap with the same interpolation become one key. */
  const mergeMeetingKeys = (list: readonly TrackedKey[]): TrackedKey[] => {
    const gap = constraints.keyGap ?? MIN_CURVE_KEY_GAP;
    const out: TrackedKey[] = [];
    for (const key of list) {
      const target = out.find((other) => Math.abs(other.time - key.time) < gap && (other.axes & key.axes) === 0
        && other.interpolation === key.interpolation);
      if (!target) {
        out.push(key);
        continue;
      }
      for (let channel = 0; channel < key.values.length; channel += 1) {
        if (!holdsAxis(key, channel)) continue;
        target.values[channel] = key.values[channel]!;
        target.arrive[channel] = key.arrive[channel]!;
        target.leave[channel] = key.leave[channel]!;
      }
      target.axes |= key.axes;
      target.origins.push(...key.origins);
    }
    return out;
  };
  /** The shift that lands key `index` on `time` after snapping it to the time step and range. */
  const snappedShift = (source: readonly EditorKey[], index: number, time: number) => snapTime(time, constraints) - source[index]!.time;
  const visibleAxes = visibleChannels.reduce((mask, channel) => mask | (1 << channel), 0) || allAxes(kind);
  const firstAxis = (axes: number) => channelInfo.findIndex((_, channel) => ((axes >> channel) & 1) === 1);

  const insertKey = (time: number) => {
    if (disabled || keys.length >= maxKeys) return;
    const t = roundTime(constraints.fixedTime ? clampNumber(time, 0, 1) : snapTime(time, constraints));
    const gap = constraints.keyGap ?? 0.001;
    // With independent axes the new key sets the visible axes only.
    const axes = independent ? visibleAxes : allAxes(kind);
    if (keys.some((key) => (key.axes & axes) !== 0 && Math.abs(key.time - t) < gap)) return;
    if (constraints.lockEnds && (t <= 0 || t >= 1)) return;
    const index = keys.findIndex((key) => key.time > t);
    const at = index < 0 ? keys.length : index;
    const next: TrackedKey[] = cloneKeys(keys).map((key, origin) => ({ ...key, origins: [origin] }));
    next.splice(at, 0, { ...keyAt(kind, keys, t, constraints), axes, origins: [-1] });
    const result = independent ? mergeMeetingKeys(next) : next;
    const created = result.findIndex((key) => key.origins.includes(-1));
    select([{ index: created, channel: holdsAxis(result[created]!, fallbackChannel()) ? fallbackChannel() : firstAxis(axes) }]);
    emit(result.map(untrack));
  };

  /** Removes the keys at `indices` except locked ends, keeping at least `minKeys`; returns the first removed index. */
  const removeKeys = (indices: readonly number[], channel: number): number | null => {
    if (disabled) return null;
    const allowed = [...new Set(indices)].filter((index) => index >= 0 && index <= last && !locked(index))
      .sort((a, b) => a - b).slice(0, Math.max(0, keys.length - minKeys));
    if (allowed.length === 0) return null;
    const removing = new Set(allowed);
    select([{ index: Math.max(0, allowed[0]! - 1), channel }]);
    emit(keys.filter((_, index) => !removing.has(index)));
    return allowed[0]!;
  };
  /**
   * Removes what the handles point at: whole keys, or with independent axes each handle's axis from its key
   * (a key left with no axes goes). Returns the index to select next, or null when nothing changed.
   */
  const removeHandles = (handles: readonly KeyHandle[]): number | null => {
    const channel = handles[handles.length - 1]?.channel ?? fallbackChannel();
    if (!independent) {
      const first = removeKeys(handles.map((handle) => handle.index), channel);
      return first === null ? null : Math.max(0, first - 1);
    }
    if (disabled) return null;
    const next = cloneKeys(keys);
    let first = Number.POSITIVE_INFINITY;
    for (const handle of handles) {
      const key = next[handle.index];
      if (!key || !holdsAxis(key, handle.channel)) continue;
      key.axes &= ~(1 << handle.channel);
      first = Math.min(first, handle.index);
    }
    if (!Number.isFinite(first)) return null;
    const removedTime = keys[first]!.time;
    const kept = next.filter((key) => key.axes !== 0);
    // The nearest earlier key that still sets the channel, else the first one that does.
    let index = -1;
    kept.forEach((key, at) => { if (holdsAxis(key, channel) && key.time < removedTime) index = at; });
    if (index < 0) index = kept.findIndex((key) => holdsAxis(key, channel));
    select(index < 0 ? [] : [{ index, channel }]);
    emit(kept);
    return index;
  };
  const removeSelected = () => { removeHandles(selection); };

  const endGesture = () => {
    gestureRef.current = null;
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };

  // Keys -------------------------------------------------------------------------------------------

  /**
   * With independent axes, a dragged key lands on a key of its other axes when it comes within 6 px of it, so
   * a split key can meet its axes again (and merge back when the interpolation matches).
   */
  const meetShift = (gesture: KeyDrag, primaryTime: number, dt: number) => {
    const moving = gesture.handles.filter((handle) => handle.index === gesture.primary.index)
      .reduce((mask, handle) => mask | (1 << handle.channel), 0);
    const reach = trackWidth > 0 ? (6 / trackWidth) * spanT : 0;
    const target = primaryTime + dt;
    let best: number | null = null;
    committed.forEach((key, index) => {
      const remaining = index === gesture.primary.index ? key.axes & ~moving : key.axes;
      if (remaining === 0 || (remaining & moving) !== 0) return;
      const distance = Math.abs(key.time - target);
      if (distance <= reach && (best === null || distance < Math.abs(best - target))) best = key.time;
    });
    return best === null ? dt : best - primaryTime;
  };

  const onKeyPointerDown = (event: PointerEvent<HTMLButtonElement>, handle: KeyHandle, timeOnly: boolean) => {
    event.stopPropagation();
    setAddHere(null);
    setHover(null);
    pointerSelectRef.current = true;
    const mode = selectModeOf(event);
    const current = selectionRef.current;
    const already = current.some((other) => sameHandle(other, handle));
    // Pressing a selected key keeps the group, so dragging it moves them all; a click without a drag then selects it alone.
    const next = mode === "replace" && already ? combine(current, [handle], "add") : combine(current, [handle], mode);
    select(next);
    if (disabled || (mode === "toggle" && already)) return;
    const point = fraction(event.clientX, event.clientY);
    const key = keys[handle.index]!;
    const start = point ? toData(point.fx, point.fy) : { time: key.time, value: key.values[handle.channel]! };
    gestureRef.current = {
      kind: "key", pointerId: event.pointerId, handles: next, primary: handle, timeOnly,
      x: event.clientX, y: event.clientY, startTime: start.time, startValue: start.value,
      moved: false, collapse: mode === "replace" && already && current.length > 1,
    };
    setFrozenView(view);
    // The plot holds the capture: a key that splits or reorders mid-drag re-renders its handle elsewhere.
    trackRef.current?.setPointerCapture?.(event.pointerId);
  };

  const onHandlePointerMove = (event: PointerEvent<Element>) => {
    const gesture = gestureRef.current;
    if (!gesture || (gesture.kind !== "key" && gesture.kind !== "tangent") || gesture.pointerId !== event.pointerId) return;
    const point = fraction(event.clientX, event.clientY);
    if (!point) return;
    if (gesture.kind === "key") {
      const slop = event.pointerType === "mouse" ? MOUSE_SLOP_PX : MOVE_TOLERANCE_PX;
      if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < slop) return;
      gesture.moved = true;
      const data = toData(point.fx, point.fy);
      const primaryTime = committed[gesture.primary.index]!.time;
      let dt = snappedShift(committed, gesture.primary.index, primaryTime + data.time - gesture.startTime);
      if (independent) dt = meetShift(gesture, primaryTime, dt);
      const shifted = shiftKeys(committed, gesture.handles, dt, gesture.timeOnly ? null : data.value - gesture.startValue);
      setDraft(shifted.keys);
      select(gesture.handles.map(shifted.remap));
      return;
    }
    const source = draftRef.current ?? committed;
    const key = source[gesture.index]!;
    const kx = fxOf(key.time);
    const ky = fyOf(key.values[gesture.channel]!);
    let dx = point.fx - kx;
    const dy = point.fy - ky;
    dx = gesture.side === "leave" ? Math.max(dx, 1e-3) : Math.min(dx, -1e-3);
    const slope = (-dy * spanV) / (dx * spanT);
    // An Auto key becomes Custom with the tangents it already plays with, then follows the handle.
    const next = withCustomTangents(kind, source, gesture.index);
    // One slope through the key keeps it smooth: both tangents follow the handle.
    next[gesture.index]!.arrive[gesture.channel] = slope;
    next[gesture.index]!.leave[gesture.channel] = slope;
    setDraft(next);
  };

  const onHandlePointerUp = (event: PointerEvent<Element>) => {
    pointerSelectRef.current = false;
    const gesture = gestureRef.current;
    if (!gesture || (gesture.kind !== "key" && gesture.kind !== "tangent") || gesture.pointerId !== event.pointerId) return;
    endGesture();
    setFrozenView(null);
    const final = draftRef.current;
    setDraft(null);
    if (gesture.kind === "key" && !gesture.moved && gesture.collapse) select([gesture.primary]);
    if (final && JSON.stringify(final) !== JSON.stringify(committed)) emit(final);
  };

  const onHandlePointerCancel = (event: PointerEvent<Element>) => {
    pointerSelectRef.current = false;
    const gesture = gestureRef.current;
    if (gesture && "pointerId" in gesture && gesture.pointerId !== event.pointerId) return;
    if (gesture?.kind === "key") select(gesture.handles);
    endGesture();
    setFrozenView(null);
    setDraft(null);
  };

  /** Keyboard focus (Tab) selects a key that is not selected yet; a pointer press already chose the selection. */
  const onKeyFocus = (handle: KeyHandle) => {
    if (pointerSelectRef.current) {
      pointerSelectRef.current = false;
      return;
    }
    if (!selectionRef.current.some((other) => sameHandle(other, handle))) select([handle]);
  };

  const onKeyKeyDown = (event: KeyboardEvent<HTMLButtonElement>, handle: KeyHandle) => {
    if (disabled) return;
    const current = selectionRef.current;
    const handles = current.some((other) => sameHandle(other, handle)) ? current : [handle];
    const key = keys[handle.index]!;
    const large = event.shiftKey ? 10 : 1;
    const timeStep = (constraints.fixedTime ? 0.01 : spanT / 100) * large;
    const valueStep = (spanV / 100) * large;
    const nudge = (dt: number, dv: number | null) => {
      const shifted = shiftKeys(keys, handles, dt, dv);
      if (handles === current) select(current.map(shifted.remap));
      // Keep focus on the moved handle, wherever its key now sits.
      const moved = shifted.remap(handle);
      focusKeyRef.current = `${moved.index}:${moved.channel}`;
      emit(shifted.keys);
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        nudge(snappedShift(keys, handle.index, key.time + timeStep * (event.key === "ArrowLeft" ? -1 : 1)), null);
        break;
      case "ArrowUp":
      case "ArrowDown":
        nudge(0, valueStep * (event.key === "ArrowDown" ? -1 : 1));
        break;
      case "Delete":
      case "Backspace": {
        // The focused key alone, or the whole selection when it belongs to it.
        const next = removeHandles(handles);
        if (next !== null && next >= 0) focusKeyRef.current = `${next}:${handle.channel}`;
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  // Empty space: select, pan, pinch, hold, hover ----------------------------------------------------

  /** Selects the key handles inside the box from where the gesture started to the pointer. */
  const updateMarquee = (gesture: MarqueeDrag, clientX: number, clientY: number) => {
    const point = fraction(clientX, clientY);
    if (!point) return;
    const box = { x0: gesture.fx, y0: gesture.fy, x1: point.fx, y1: point.fy };
    setMarquee(box);
    const [left, right] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [top, bottom] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    const inside: KeyHandle[] = [];
    keys.forEach((key, index) => {
      const fx = fxOf(key.time);
      if (fx < left || fx > right) return;
      for (const channel of visibleChannels) {
        if (!holdsAxis(key, channel)) continue;
        const fy = handleFy(key, channel);
        if (fy >= top && fy <= bottom) inside.push({ index, channel });
      }
    });
    select(combine(gesture.base, inside, gesture.mode));
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    const mouse = event.pointerType === "mouse";
    if (mouse && event.button !== 0 && event.button !== 2) return;
    setAddHere(null);
    setHover(null);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointers = [...pointersRef.current.values()];
    if (pointers.length >= 2) {
      // A second finger cancels a pending hold or selection box and pinches.
      endGesture();
      setMarquee(null);
      const [a, b] = pointers as [{ x: number; y: number }, { x: number; y: number }];
      const mid = fraction((a.x + b.x) / 2, (a.y + b.y) / 2);
      gestureRef.current = { kind: "pinch", start: view, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, fx: mid?.fx ?? 0.5, fy: mid?.fy ?? 0.5 };
      return;
    }
    const at = fraction(event.clientX, event.clientY);
    if (mouse && event.button === 0) {
      // A mouse drag draws a selection box: Shift adds to the selection, Ctrl/Cmd toggles.
      gestureRef.current = {
        kind: "marquee", pointerId: event.pointerId, x: event.clientX, y: event.clientY, fx: at?.fx ?? 0, fy: at?.fy ?? 0,
        mode: selectModeOf(event), base: selectionRef.current, active: false,
      };
      return;
    }
    // A finger or a right-drag pans. A right-click, or a held finger released in place, offers Add Key Here;
    // a held finger that then moves draws a selection box instead.
    const pan: PanDrag = {
      kind: "pan", pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: view,
      moved: false, held: false, menu: mouse, fx: at?.fx ?? 0, fy: at?.fy ?? 0,
    };
    gestureRef.current = pan;
    if (!mouse) {
      longPressRef.current = setTimeout(() => {
        longPressRef.current = null;
        if (gestureRef.current === pan && !pan.moved) pan.held = true;
      }, LONG_PRESS_MS);
    }
  };

  /** A key or tangent drag the plot captured: its moves and release arrive here. */
  const handleGestureOf = (event: PointerEvent<Element>) => {
    const gesture = gestureRef.current;
    return gesture && (gesture.kind === "key" || gesture.kind === "tangent") && gesture.pointerId === event.pointerId ? gesture : null;
  };

  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (handleGestureOf(event)) {
      onHandlePointerMove(event);
      return;
    }
    if (!pointersRef.current.has(event.pointerId)) {
      // A mouse over the plot with no button down reads out the curve.
      if (event.pointerType === "mouse" && !gestureRef.current) {
        const point = fraction(event.clientX, event.clientY);
        setHover(point ? { fx: point.fx, fy: point.fy } : null);
      }
      return;
    }
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
    if ((gesture.kind !== "pan" && gesture.kind !== "marquee") || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.kind === "marquee") {
      if (!gesture.active && Math.hypot(dx, dy) < MOUSE_SLOP_PX) return;
      gesture.active = true;
      updateMarquee(gesture, event.clientX, event.clientY);
      return;
    }
    if (!gesture.moved && Math.hypot(dx, dy) < MOVE_TOLERANCE_PX) return;
    if (gesture.held) {
      // Hold, then move: a selection box from where the finger came down.
      const box: MarqueeDrag = {
        kind: "marquee", pointerId: event.pointerId, x: gesture.x, y: gesture.y, fx: gesture.fx, fy: gesture.fy,
        mode: "replace", base: [], active: true,
      };
      gestureRef.current = box;
      updateMarquee(box, event.clientX, event.clientY);
      return;
    }
    gesture.moved = true;
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
    const dt = constraints.fixedTime ? 0 : (-dx / rect.width) * (gesture.start.t1 - gesture.start.t0);
    const dv = (dy / rect.height) * (gesture.start.v1 - gesture.start.v0);
    setUserView({ t0: gesture.start.t0 + dt, t1: gesture.start.t1 + dt, v0: gesture.start.v0 + dv, v1: gesture.start.v1 + dv });
  };

  const onTrackPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (handleGestureOf(event)) {
      if (event.type === "pointerup") onHandlePointerUp(event);
      else onHandlePointerCancel(event);
      return;
    }
    const gesture = gestureRef.current;
    if (event.type === "pointerup" && gesture && gesture.kind !== "pinch" && gesture.pointerId === event.pointerId) {
      if (gesture.kind === "pan" && !gesture.moved) {
        if (gesture.menu || gesture.held) {
          if (!disabled && keys.length < maxKeys) setAddHere({ time: toData(gesture.fx, gesture.fy).time, fx: gesture.fx, fy: gesture.fy });
        } else {
          // A tap on empty space clears the selection.
          select([]);
        }
      } else if (gesture.kind === "marquee" && !gesture.active && gesture.mode === "replace") {
        select([]);
      }
    }
    setMarquee(null);
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) endGesture();
  };

  const onTrackDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    const point = fraction(event.clientX, event.clientY);
    if (point) insertKey(toData(point.fx, point.fy).time);
  };

  // Selected key fields: every selected key takes the value; one change when the scrub or typed edit ends --

  const applyEdit = (next: EditorKey[], commit: boolean) => {
    if (commit) {
      setDraft(null);
      emit(next);
    } else {
      setDraft(next);
    }
  };
  const editSelectedKeys = (change: (key: EditorKey) => void, commit: boolean) => {
    const next = cloneKeys(committed);
    for (const index of selectedIndices) {
      const key = next[index];
      if (key) change(key);
    }
    applyEdit(next, commit);
  };
  /** Time moves every selected key by the primary key's change, so they keep their spacing. */
  const setSelectedTime = (time: number, commit: boolean) => {
    const base = timeBaseRef.current ?? selection;
    timeBaseRef.current = commit ? null : base;
    const anchor = base[base.length - 1];
    if (!anchor) return;
    const shifted = shiftKeys(committed, base, snappedShift(committed, anchor.index, time), null);
    select(base.map(shifted.remap));
    applyEdit(shifted.keys, commit);
  };
  /** The selected keys that set `channel` (every selected key without one). */
  const holders = (channel?: number) => selectedIndices.map((index) => keys[index]).filter(
    (key): key is EditorKey => !!key && (channel === undefined || holdsAxis(key, channel)));
  const differs = (read: (key: EditorKey) => unknown, channel?: number) => {
    const [first, ...rest] = holders(channel);
    return !!first && rest.some((key) => read(key) !== read(first));
  };

  const setInterpolation = (interpolation: CurveInterpolation) => {
    if (!selectedKey) return;
    if (independent) {
      // Only the selected axes change: they split into their own key at the same time, and merge back when they match.
      const shifted = shiftKeys(keys, selection, 0, null, {
        split: true,
        change: (key, origin) => {
          if (interpolation === "custom" && key.interpolation !== "custom") {
            key.arrive = key.values.map((_, channel) => keyTangent(kind, keys, origin, channel, "arrive"));
            key.leave = key.values.map((_, channel) => keyTangent(kind, keys, origin, channel, "leave"));
          }
          key.interpolation = interpolation;
        },
      });
      select(selection.map(shifted.remap));
      emit(shifted.keys);
      return;
    }
    let next = cloneKeys(keys);
    for (const index of selectedIndices) {
      // Custom starts from the tangents the key plays with now, so choosing it never moves the curve.
      if (interpolation === "custom") next = withCustomTangents(kind, next, index);
      next[index]!.interpolation = interpolation;
    }
    emit(next);
  };

  const setSelectedColor = (rgb: readonly [number, number, number]) => {
    if (!selectedKey) return;
    editSelectedKeys((key) => { key.values = [rgb[0], rgb[1], rgb[2], key.values[3] ?? 1]; }, true);
  };

  const keyId = (index: number, channel: number) =>
    channelInfo.length === 1 ? `${testId}-key-${index}` : `${testId}-key-${index}-${channelInfo[channel]!.key}`;
  /** Share of the plot to the nearest key that sets `channel`, which caps a touch hit area. */
  const hitFraction = (index: number, channel: number) => {
    let left = 1;
    let right = 1;
    for (let other = index - 1; other >= 0; other -= 1) {
      if (holdsAxis(keys[other]!, channel)) { left = (keys[index]!.time - keys[other]!.time) / spanT; break; }
    }
    for (let other = index + 1; other <= last; other += 1) {
      if (holdsAxis(keys[other]!, channel)) { right = (keys[other]!.time - keys[index]!.time) / spanT; break; }
    }
    return Math.max(0, Math.min(left, right, 1));
  };
  const activeChannel = primary && visible[primary.channel] !== false ? primary.channel : visibleChannels[0] ?? 0;
  // The selected channel draws last, on top of the others.
  const drawOrder = [...visibleChannels].sort((a, b) => Number(a === activeChannel) - Number(b === activeChannel));
  const showTangents = !lockedInterpolation && !disabled && !!selectedKey
    && (selectedKey.interpolation === "custom" || selectedKey.interpolation === "auto");
  const tangentPx = touch ? 70 : 46;

  // Rulers, grid and extrapolated ranges ------------------------------------------------------------

  const timeTicks = rulerTicks(view.t0, view.t1, trackWidth || 240, 90);
  const valueTicks = rulerTicks(view.v0, view.v1, trackHeight || 120, 44);
  const reachFx = trackWidth > 0 ? inset / trackWidth : 0;
  const firstFx = keys.length ? fxOf(keys[0]!.time) : 0;
  const lastFx = keys.length ? fxOf(keys[last]!.time) : 1;
  const beforeZonePx = keys.length > 1 ? inset + firstFx * trackWidth : 0;
  const afterZonePx = keys.length > 1 ? inset + (1 - lastFx) * trackWidth : 0;
  const beforeMode = (curve.Before ?? "constant") as CurveExtrapolation;
  const afterMode = (curve.After ?? "constant") as CurveExtrapolation;

  const hoverTime = hover ? view.t0 + hover.fx * spanT : 0;
  const hoverValues = hover ? visibleChannels.map((channel) => ({ channel, value: sampleChannel(kind, curve, channel, hoverTime) })) : [];

  const fitButton = (
    <Button type="button" variant={isWindow ? "outline" : "ghost"} size="xs" className={cn("ml-auto", !isWindow && "pointer-coarse:min-h-11")}
      disabled={keys.length === 0} onClick={() => setUserView(null)} data-testid={`${testId}-fit`}>
      <Maximize2Icon data-icon="inline-start" aria-hidden="true" />
      Fit
      {isWindow && fitShortcut ? <ShortcutKeys chord={fitShortcut} decorative className="ml-0.5" /> : null}
    </Button>
  );

  const toolbar = (
    <div className={cn("flex items-center gap-1", isWindow ? "h-8 shrink-0 border-b bg-panel-header px-1.5" : "flex-wrap")}>
      {multi ? (
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
          {channelInfo.map((channel, index) => (
            <ToggleGroupItem
              key={channel.label}
              value={channel.label}
              aria-label={`Show ${channel.label}`}
              className={cn("gap-1.5", isWindow ? "h-6" : "pointer-coarse:min-h-11")}
              data-testid={`${testId}-channel-${channel.label}`}
            >
              <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", visible[index] === false && "opacity-40")} style={{ background: channel.stroke }} />
              {channel.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {multi && isWindow ? <Separator orientation="vertical" className="mx-0.5 h-4 self-center" /> : null}
      <Button type="button" variant="outline" size="xs" className={cn(!isWindow && "pointer-coarse:min-h-11")} disabled={!canAdd}
        onClick={() => { if (insertion) insertKey(insertion.time); }} data-testid={`${testId}-add`}>
        <PlusIcon data-icon="inline-start" aria-hidden="true" />
        Add Key
      </Button>
      <Button type="button" variant="outline" size="xs" className={cn(!isWindow && "pointer-coarse:min-h-11")} disabled={!canRemove}
        onClick={removeSelected} data-testid={`${testId}-remove`}>
        <Trash2Icon data-icon="inline-start" aria-hidden="true" />
        {multiKeys ? "Remove Keys" : "Remove Key"}
      </Button>
      {fitButton}
    </div>
  );

  const keyRow = (index: number, key: EditorKey, channel: number) => {
    if (!holdsAxis(key, channel)) return null;
    const fx = fxOf(key.time);
    const fy = handleFy(key, channel);
    if (fx < -0.02 - reachFx || fx > 1.02 + reachFx || fy < -0.04 || fy > 1.04) return null;
    const isSelected = isSelectedHandle(index, channel);
    const id = keyId(index, channel);
    const stroke = channelInfo[channel]!.stroke;
    const label = !multi
      ? `Key ${index + 1}, Time ${key.time.toFixed(2)}, Value ${key.values[0]!.toFixed(2)}`
      : `Key ${index + 1} ${channelInfo[channel]!.label}, Time ${key.time.toFixed(2)}, Value ${key.values[channel]!.toFixed(2)}`;
    return (
      // Raw handles: Button primitives grow to 44×44 in touch rows; these cap at the gap to their neighbours.
      <button
        key={`${index}:${channel}`}
        ref={(element) => { keyRefs.current.set(`${index}:${channel}`, element); }}
        type="button"
        className={cn(
          "absolute flex size-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-[min(44px,var(--curve-key-hit))]",
          isSelected && "z-10",
        )}
        style={{ left: `${fx * 100}%`, top: `${fy * 100}%`, "--curve-key-hit": `${hitFraction(index, channel) * 100}%` } as CSSProperties}
        aria-label={label}
        aria-pressed={isSelected}
        disabled={disabled}
        onPointerDown={(event) => onKeyPointerDown(event, { index, channel }, false)}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        onFocus={() => onKeyFocus({ index, channel })}
        onKeyDown={(event) => onKeyKeyDown(event, { index, channel })}
        data-testid={id}
      >
        <span
          aria-hidden="true"
          className={cn("size-2.5 rounded-full border-2", isSelected && "ring-4 ring-ring/25")}
          style={{
            borderColor: isSelected ? "var(--graph-state-selected)" : stroke,
            background: isSelected ? "var(--graph-state-selected)" : selectedIndices.includes(index) ? stroke : "var(--background)",
          }}
        />
      </button>
    );
  };

  const tangentHandles = showTangents && selectedKey ? (["arrive", "leave"] as const).map((side) => {
    const channel = activeChannel;
    const slope = keyTangent(kind, keys, selectedIndex, channel, side);
    const [ox, oy] = tangentOffset(slope, view, trackWidth, trackHeight, tangentPx);
    const sign = side === "leave" ? 1 : -1;
    const fx = fxOf(selectedKey.time) + sign * ox;
    const fy = fyOf(selectedKey.values[channel]!) + sign * oy;
    return { side, channel, fx, fy };
  }) : [];
  const automatic = selectedKey?.interpolation === "auto";

  const timeLabel = (time: number) => timeTicks.decimals ? time.toFixed(timeTicks.decimals) : String(Math.round(time));
  const valueLabel = (entry: number) => valueTicks.decimals ? entry.toFixed(valueTicks.decimals) : String(Math.round(entry));

  const plot = (
    <div
      className={cn(
        "relative isolate flex touch-none flex-col overflow-hidden bg-control",
        isWindow ? "min-h-0 flex-1" : "h-[166px] rounded-md border border-input pointer-coarse:h-[216px]",
      )}
      data-testid={`${testId}-plot`}
    >
      {/* Time ruler */}
      <div className="flex h-4 shrink-0 border-b bg-panel-header">
        <div className="shrink-0 border-r" style={{ width: VALUE_RULER_WIDTH }} />
        <div className="relative min-w-0 flex-1 overflow-hidden" data-testid={`${testId}-ruler-time`}>
          <div className="absolute inset-y-0" style={{ left: inset, right: inset }}>
            {axisLabels ? (
              <>
                <span className="absolute top-0 left-0 pl-1.5 text-[10px] leading-[11px] text-muted-foreground" data-testid={`${testId}-time-start`}>{axisLabels.start}</span>
                <span className="absolute top-0 right-0 pr-1.5 text-[10px] leading-[11px] text-muted-foreground" data-testid={`${testId}-time-end`}>{axisLabels.end}</span>
              </>
            ) : (
              <>
                {timeTicks.minor.map((time) => (
                  <span key={`m${time}`} aria-hidden="true" className="absolute bottom-0 h-1 w-px bg-muted-foreground/40" style={{ left: `${fxOf(time) * 100}%` }} />
                ))}
                {timeTicks.major.map((time) => (
                  <span key={time} className="absolute inset-y-0 border-l border-muted-foreground/60 pl-0.5 text-[10px] leading-[11px] text-muted-foreground tabular-nums" style={{ left: `${fxOf(time) * 100}%` }}>
                    {timeLabel(time)}
                  </span>
                ))}
              </>
            )}
            {selectedIndices.map((index) => (
              <span key={`s${index}`} aria-hidden="true" className="absolute bottom-0 size-0 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent" style={{ left: `${fxOf(keys[index]!.time) * 100}%`, borderTopColor: "var(--graph-state-selected)" }} />
            ))}
            {hover ? (
              <span className="absolute top-0 z-10 -translate-x-1/2 rounded-sm border border-input bg-popover px-1 text-[10px] leading-[14px] font-semibold text-popover-foreground tabular-nums" style={{ left: `${hover.fx * 100}%` }} data-testid={`${testId}-hover-time`}>
                {`${hoverTime.toFixed(2)} s`}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {showLane ? (
        <div className="relative z-20 flex h-5 shrink-0 border-b bg-panel-header">
          <div className="flex shrink-0 items-center justify-end border-r pr-1.5 text-[10px] text-muted-foreground" style={{ width: VALUE_RULER_WIDTH }}>Color</div>
          <div className="relative min-w-0 flex-1" data-testid={`${testId}-lane`}>
            <div
              aria-hidden="true"
              className="absolute inset-y-[3px] inset-x-0"
              style={{ background: gradientBackground(curve, [view.t0 - reachFx * spanT, view.t1 + reachFx * spanT], 48) }}
            />
            <div role="group" aria-label={`${ariaLabel} Gradient Stops`} className="absolute inset-y-0" style={{ left: inset, right: inset }}>
              {keys.map((key, index) => {
                const fx = fxOf(key.time);
                if (fx < -reachFx - 0.02 || fx > 1 + reachFx + 0.02) return null;
                const isSelected = selectedIndices.includes(index);
                return (
                  // Raw handles: the 28px (touch 44px) hit area overhangs the 20px lane and caps at the gap to its neighbours.
                  <button
                    key={index}
                    type="button"
                    className={cn(
                      "absolute top-1/2 flex h-7 w-[min(28px,var(--curve-key-hit))] -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-[min(44px,var(--curve-key-hit))]",
                      isSelected && "z-10",
                    )}
                    style={{ left: `${fx * 100}%`, "--curve-key-hit": `${(trackWidth ? hitFraction(index, activeChannel) * trackWidth : 28)}px` } as CSSProperties}
                    aria-label={`Stop ${index + 1}, Time ${key.time.toFixed(2)}`}
                    aria-pressed={isSelected}
                    disabled={disabled}
                    onPointerDown={(event) => onKeyPointerDown(event, { index, channel: activeChannel }, true)}
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp}
                    onPointerCancel={onHandlePointerCancel}
                    onFocus={() => onKeyFocus({ index, channel: activeChannel })}
                    onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Delete" || event.key === "Backspace") onKeyKeyDown(event, { index, channel: activeChannel }); }}
                    data-testid={`${testId}-stop-${index}`}
                  >
                    <span aria-hidden="true" className={cn("h-[18px] rounded-[2px] border border-control", isSelected ? "w-1" : "w-[3px] bg-foreground")}
                      style={isSelected ? { background: "var(--graph-state-selected)" } : undefined} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* Value ruler */}
        <div className="relative shrink-0 overflow-hidden border-r bg-panel-header" style={{ width: VALUE_RULER_WIDTH }} data-testid={`${testId}-ruler-value`}>
          <div className="absolute inset-x-0" style={{ top: inset, bottom: inset }}>
            {valueTicks.major.map((entry) => (
              <span key={entry} className="absolute right-1.5 -translate-y-1/2 text-[10px] leading-none text-muted-foreground tabular-nums" style={{ top: `${fyOf(entry) * 100}%` }}>
                {valueLabel(entry)}
              </span>
            ))}
          </div>
        </div>
        <div ref={canvasRef} className="relative min-w-0 flex-1 overflow-hidden">
          {keys.length > 1 && beforeZonePx > ZONE_LABEL_MIN_PX && !constraints.fixedTime ? (
            <span className="pointer-events-none absolute top-1 left-1.5 z-[1] text-[10px] text-muted-foreground" data-testid={`${testId}-zone-before`}>
              {`Before · ${EXTRAPOLATION_LABELS[beforeMode]}`}
            </span>
          ) : null}
          {keys.length > 1 && afterZonePx > ZONE_LABEL_MIN_PX && !constraints.fixedTime ? (
            <span className="pointer-events-none absolute top-1 right-1.5 z-[1] text-[10px] text-muted-foreground" data-testid={`${testId}-zone-after`}>
              {`After · ${EXTRAPOLATION_LABELS[afterMode]}`}
            </span>
          ) : null}
          <div
            ref={trackRef}
            role="group"
            aria-label={`${ariaLabel} Curve Keys`}
            className="absolute"
            style={{ inset }}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerUp}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={onTrackDoubleClick}
            onContextMenu={(event) => event.preventDefault()}
            data-testid={`${testId}-track`}
          >
            {keys.length > 1 && !constraints.fixedTime ? (
              <>
                <div aria-hidden="true" className={cn("pointer-events-none absolute", HATCH)}
                  style={{ left: -inset, top: -inset, bottom: -inset, width: `max(0px, calc(${firstFx * 100}% + ${inset}px))` }} />
                <div aria-hidden="true" className={cn("pointer-events-none absolute", HATCH)}
                  style={{ left: `${lastFx * 100}%`, right: -inset, top: -inset, bottom: -inset }} />
              </>
            ) : null}
            <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {timeTicks.minor.map((time) => {
                const x = fxOf(time) * 100;
                return <line key={`tm${time}`} x1={x} x2={x} y1={-100} y2={200} className="stroke-foreground/5" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
              })}
              {valueTicks.minor.map((entry) => {
                const y = fyOf(entry) * 100;
                return <line key={`vm${entry}`} x1={-100} x2={200} y1={y} y2={y} className="stroke-foreground/5" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
              })}
              {timeTicks.major.map((time) => {
                const x = fxOf(time) * 100;
                return <line key={`t${time}`} x1={x} x2={x} y1={-100} y2={200} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
              })}
              {valueTicks.major.map((entry) => {
                const y = fyOf(entry) * 100;
                return <line key={`v${entry}`} x1={-100} x2={200} y1={y} y2={y} className={entry === 0 ? "stroke-input" : "stroke-border"} strokeWidth={entry === 0 ? 1.5 : 1} vectorEffect="non-scaling-stroke" />;
              })}
              {drawOrder.map((channel) => {
                const stroke = channelInfo[channel]!.stroke;
                const front = !multi || channel === activeChannel;
                const from = -reachFx;
                const to = 1 + reachFx;
                if (keys.length < 2 || constraints.fixedTime) {
                  return <polyline key={channel} className="fill-none" style={{ stroke, opacity: front ? 1 : 0.8 }} strokeWidth={front ? 2 : 1.5}
                    vectorEffect="non-scaling-stroke" points={channelPoints(kind, curve, channel, view, 160, from, to)} />;
                }
                return (
                  <g key={channel} style={{ opacity: front ? 1 : 0.8 }}>
                    <polyline className="fill-none" style={{ stroke, opacity: 0.55 }} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
                      points={channelPoints(kind, curve, channel, view, 160, from, Math.min(firstFx, to))} />
                    <polyline className="fill-none" style={{ stroke, opacity: 0.55 }} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
                      points={channelPoints(kind, curve, channel, view, 160, Math.max(lastFx, from), to)} />
                    <polyline className="fill-none" style={{ stroke }} strokeWidth={front ? 2 : 1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                      points={channelPoints(kind, curve, channel, view, 160, Math.max(firstFx, from), Math.min(lastFx, to))} />
                  </g>
                );
              })}
              {tangentHandles.map(({ side, channel, fx, fy }) => (
                <line key={side} x1={fxOf(selectedKey!.time) * 100} y1={fyOf(selectedKey!.values[channel]!) * 100} x2={fx * 100} y2={fy * 100}
                  className="stroke-muted-foreground" strokeWidth={1} strokeDasharray={automatic ? "3 3" : undefined} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            {hover ? (
              <>
                <div aria-hidden="true" className="pointer-events-none absolute w-px bg-foreground/30" style={{ left: `${hover.fx * 100}%`, top: -inset, bottom: -inset }} />
                {hoverValues.map(({ channel, value: channelValue }) => (
                  <span key={channel} aria-hidden="true" className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-control"
                    style={{ left: `${hover.fx * 100}%`, top: `${fyOf(channelValue) * 100}%`, background: channelInfo[channel]!.stroke }} />
                ))}
              </>
            ) : null}
            {keys.flatMap((key, index) => drawOrder.map((channel) => keyRow(index, key, channel)))}
            {tangentHandles.map(({ side, channel, fx, fy }) => (
              <button
                key={side}
                type="button"
                className="absolute z-20 flex size-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11"
                style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
                aria-label={`${side === "leave" ? "Leave" : "Arrive"} Tangent`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setHover(null);
                  gestureRef.current = { kind: "tangent", pointerId: event.pointerId, index: selectedIndex, channel, side };
                  setFrozenView(view);
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandlePointerCancel}
                data-testid={`${testId}-tangent-${side}`}
              >
                <span aria-hidden="true" className={cn("size-2 rotate-45 border border-foreground", automatic ? "bg-control" : "bg-foreground")} />
              </button>
            ))}
            {hover && hoverValues.length ? (
              <div
                className="pointer-events-none absolute z-30 flex gap-2 rounded-md border border-input bg-popover px-1.5 py-0.5 text-[11px] whitespace-nowrap text-popover-foreground tabular-nums shadow-sm"
                style={{
                  left: `${hover.fx * 100}%`,
                  top: `${hover.fy * 100}%`,
                  transform: `translate(${hover.fx > 0.6 ? "calc(-100% - 10px)" : "10px"}, ${hover.fy < 0.2 ? "12px" : "calc(-100% - 8px)"})`,
                }}
                data-testid={`${testId}-hover`}
              >
                {hoverValues.map(({ channel, value: channelValue }) => (
                  <span key={channel}>
                    {multi ? <span className="mr-1 font-semibold" style={{ color: channelInfo[channel]!.stroke }}>{channelInfo[channel]!.label}</span> : null}
                    {channelValue.toFixed(2)}
                  </span>
                ))}
              </div>
            ) : null}
            {marquee ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute z-30 border"
                style={{
                  left: `${Math.min(marquee.x0, marquee.x1) * 100}%`,
                  top: `${Math.min(marquee.y0, marquee.y1) * 100}%`,
                  width: `${Math.abs(marquee.x1 - marquee.x0) * 100}%`,
                  height: `${Math.abs(marquee.y1 - marquee.y0) * 100}%`,
                  background: "color-mix(in oklch, var(--selection) 12%, transparent)",
                  borderColor: "color-mix(in oklch, var(--selection) 80%, transparent)",
                }}
                data-testid={`${testId}-marquee`}
              />
            ) : null}
            {addHere ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="absolute z-30 -translate-x-1/2 -translate-y-full pointer-coarse:min-h-11"
                style={{ left: `${clampNumber(addHere.fx, 0.1, 0.9) * 100}%`, top: `${clampNumber(addHere.fy, 0.2, 1) * 100}%` }}
                onClick={() => { insertKey(addHere.time); setAddHere(null); }}
                data-testid={`${testId}-add-here`}
              >
                Add Key Here
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );

  const fieldLabel = multiKeys ? `${ariaLabel} Selected Keys` : `${ariaLabel} Key ${selectedIndex + 1}`;
  const timeField = selectedKey ? (
    <NumericDragField
      aria-label={`${fieldLabel} Time`}
      value={selectedKey.time}
      mixed={multiKeys}
      unit={isWindow ? "s" : undefined}
      min={constraints.fixedTime ? 0 : constraints.timeRange?.[0]}
      max={constraints.fixedTime ? 1 : constraints.timeRange?.[1]}
      sensitivity={constraints.fixedTime ? 0.005 : spanT / 200}
      disabled={disabled || timeLocked}
      onChange={(time) => setSelectedTime(time, false)}
      onDragEnd={(time) => setSelectedTime(time, true)}
      data-testid={`${testId}-time`}
    />
  ) : null;

  const valueField = (index: number) => {
    const channel = channelInfo[index]!;
    return (
      <NumericDragField
        aria-label={`${fieldLabel} ${!multi ? "Value" : channel.label}`}
        value={(holders(index)[0] ?? selectedKey!).values[index]!}
        mixed={differs((key) => key.values[index], index)}
        min={constraints.valueMin}
        max={constraints.valueMax}
        accent={channel.accent}
        sensitivity={spanV / 200}
        disabled={disabled}
        onChange={(next) => editSelectedKeys((key) => { if (holdsAxis(key, index)) key.values[index] = clampValue(next, constraints); }, false)}
        onDragEnd={(next) => editSelectedKeys((key) => { if (holdsAxis(key, index)) key.values[index] = clampValue(next, constraints); }, true)}
        data-testid={!multi ? `${testId}-value` : `${testId}-value-${channel.label}`}
      />
    );
  };

  const interpolationSelect = selectedKey && !lockedInterpolation ? (
    <InterpolationSelect
      aria-label={`${fieldLabel} Interpolation`}
      value={selectedKey.interpolation}
      mixed={differs((key) => key.interpolation)}
      disabled={disabled}
      compact={isWindow}
      onChange={setInterpolation}
      data-testid={`${testId}-interpolation`}
    />
  ) : null;

  /** Selects the key before or after the primary one (the last or first key when none is selected). */
  const stepKey = (direction: -1 | 1) => {
    if (keys.length === 0) return;
    const index = primary ? clampNumber(primary.index + direction, 0, last) : direction > 0 ? 0 : last;
    select([{ index, channel: fallbackChannel() }]);
  };

  if (isWindow) {
    const color = (selectedKey?.values ?? [0, 0, 0, 1]) as unknown as Rgba;
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid={testId}>
        {toolbar}
        {plot}
        <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-panel-header px-1.5 py-1" data-testid={`${testId}-key-bar`}>
          <div className="flex items-center">
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous Key" disabled={keys.length === 0 || (!!primary && selectedIndex <= 0)}
              onClick={() => stepKey(-1)} data-testid={`${testId}-previous-key`}>
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <span className="min-w-[6.5rem] text-center text-xs text-muted-foreground tabular-nums" data-testid={`${testId}-key-count`}>
              {keys.length === 0 ? "No Keys"
                : !selectedKey ? "No Key Selected"
                  : multiKeys ? <><span className="font-semibold text-foreground">{selectedIndices.length}</span> Keys Selected</>
                    : <>Key <span className="font-semibold text-foreground">{selectedIndex + 1}</span> of {keys.length}</>}
            </span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Next Key" disabled={keys.length === 0 || (!!primary && selectedIndex >= last)}
              onClick={() => stepKey(1)} data-testid={`${testId}-next-key`}>
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </div>
          {selectedKey ? (
            <>
              <Separator orientation="vertical" className="h-4 self-center" />
              <KeyBarField label="Time" width="w-20">{timeField}</KeyBarField>
              <Separator orientation="vertical" className="h-4 self-center" />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {kind === "color" ? (
                  <div className="w-40">
                    <ColorField
                      aria-label={`${fieldLabel} Color`}
                      value={[color[0], color[1], color[2]]}
                      disabled={disabled}
                      onChange={setSelectedColor}
                      data-testid={`${testId}-color`}
                    />
                  </div>
                ) : null}
                {channelInfo.map((channel, index) => (holders(index).length === 0 ? null : (
                  <KeyBarField key={channel.label} label={!multi ? "Value" : channel.label} width="w-20" accent={multi ? channel.stroke : undefined}>
                    {valueField(index)}
                  </KeyBarField>
                )))}
              </div>
              {interpolationSelect ? (
                <>
                  <Separator orientation="vertical" className="h-4 self-center" />
                  <KeyBarField label="Interpolation" width="w-32">{interpolationSelect}</KeyBarField>
                </>
              ) : null}
            </>
          ) : null}
          <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
            {touch ? "Hold and drag to select · Hold to add a key" : "Drag to select · Double-click or right-click to add a key"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      {toolbar}
      {plot}
      {selectedKey ? (
        <div className="grid grid-cols-2 gap-1">
          <div className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">Time</span>
            <div className="min-w-0 flex-1">{timeField}</div>
          </div>
          {channelInfo.map((channel, index) => (holders(index).length === 0 ? null : (
            <div key={channel.label} className="flex min-w-0 items-center gap-1">
              <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">{!multi ? "Value" : channel.label}</span>
              <div className="min-w-0 flex-1">{valueField(index)}</div>
            </div>
          )))}
          {interpolationSelect ? (
            <div className="flex min-w-0 items-center gap-1">
              <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">Interpolation</span>
              {interpolationSelect}
            </div>
          ) : null}
        </div>
      ) : null}
      {constraints.fixedTime || constraints.extrapolation ? null : (
        <div className="grid grid-cols-2 gap-1">
          {(["Before", "After"] as const).map((end) => (
            <div key={end} className="flex min-w-0 items-center gap-1">
              <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">{end}</span>
              <ExtrapolationSelect
                aria-label={`${ariaLabel} ${end}`}
                value={(end === "Before" ? curve.Before : curve.After) as CurveExtrapolation}
                disabled={disabled}
                onChange={(next) => emit(keys, end === "Before" ? next : curve.Before, end === "After" ? next : curve.After)}
                data-testid={`${testId}-${end.toLowerCase()}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KeyBarField({ label, width, accent, children }: { label: string; width: string; accent?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("text-xs", accent ? "font-semibold" : "text-muted-foreground")} style={accent ? { color: accent } : undefined}>{label}</span>
      <div className={width}>{children}</div>
    </div>
  );
}

/** Interpolation picker: Constant, Linear, Auto and Custom, then the easing curves under **Ease**. */
function InterpolationSelect({ "aria-label": ariaLabel, value, mixed, disabled, compact, onChange, "data-testid": testId }: {
  "aria-label": string;
  value: CurveInterpolation;
  /** The selected keys differ; the trigger reads Mixed until one is chosen. */
  mixed?: boolean;
  disabled?: boolean;
  /** Keeps the compact height in the touch layout (the Curve asset window's key bar). */
  compact?: boolean;
  onChange: (value: CurveInterpolation) => void;
  "data-testid"?: string;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => { if (next != null) onChange(next as CurveInterpolation); }}>
      <SelectTrigger aria-label={ariaLabel} size="sm" className={cn("w-full min-w-0 flex-1", !compact && "pointer-coarse:min-h-11")} data-testid={testId}>
        <SelectValue>{(current: unknown) => (mixed ? "Mixed" : interpolationLabel((current ?? value) as CurveInterpolation))}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {BASIC_INTERPOLATIONS.map((option) => <SelectItem key={option} value={option}>{interpolationLabel(option)}</SelectItem>)}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Ease</SelectLabel>
          {EASE_INTERPOLATIONS.map((option) => <SelectItem key={option} value={option}>{interpolationLabel(option)}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Before or After picker: Constant, Linear, Cycle or Oscillate. */
function ExtrapolationSelect({ "aria-label": ariaLabel, value, disabled, onChange, className, "data-testid": testId }: {
  "aria-label": string;
  value: CurveExtrapolation;
  disabled?: boolean;
  onChange: (value: CurveExtrapolation) => void;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => { if (next != null) onChange(next as CurveExtrapolation); }}>
      <SelectTrigger aria-label={ariaLabel} size="sm" className={cn("min-w-0 flex-1 pointer-coarse:min-h-11", className)} data-testid={testId}>
        <SelectValue>{(current: unknown) => EXTRAPOLATION_LABELS[(current ?? value) as CurveExtrapolation] ?? String(current ?? "")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {CURVE_EXTRAPOLATIONS.map((option) => <SelectItem key={option} value={option}>{EXTRAPOLATION_LABELS[option]}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
