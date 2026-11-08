import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, ChevronRightIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import {
  fitKeyframeView,
  keyAt,
  keyReach,
  keyRefId,
  keyframeScrollHit,
  keyframeScrollRange,
  keyframeScrollThumb,
  keyframeZoomFactor,
  keysInRect,
  panKeyframeView,
  resizeKeyframeView,
  rulerTicks,
  scrollKeyframeView,
  snapToFrame,
  timeToX,
  xToTime,
  zoomKeyframeView,
  type KeyRef,
  type KeyframeScrollThumb,
  type KeyframeShape,
  type KeyframeTimeRange,
  type KeyframeTimelineRow,
  type KeyframeTimelineView,
} from "./keyframe-timeline-model";

export interface KeyframeTimelineTrackRow extends KeyframeTimelineRow {
  label: ReactNode;
  /** Indent level in the track list; 0 for objects. */
  depth: number;
  icon?: ReactNode;
  /** Right-aligned in the track list, such as the value at the playhead. */
  value?: ReactNode;
  /** Small buttons after the value, such as Add Key. */
  actions?: ReactNode;
  /** Group rows with children: whether they are open. Undefined shows no chevron. */
  expanded?: boolean;
  testId?: string;
}

export type KeySelectMode = "replace" | "toggle" | "add";
export type GesturePhase = "start" | "move" | "end" | "cancel";

export interface KeyframeTimelineProps {
  rows: readonly KeyframeTimelineTrackRow[];
  /** Clip length in seconds; the ruler and lanes are hatched after it. */
  length: number;
  frameRate: number;
  /** Playhead, in seconds. */
  time: number;
  /** Scrubbing the ruler. The time is on a frame when `snap` is on. */
  onTimeChange: (time: number, phase: GesturePhase) => void;
  /** Snap scrubbing and key drags to frames. */
  snap?: boolean;
  /** `keyRefId` of each selected key. */
  selectedKeys: ReadonlySet<string>;
  onSelectKeys: (refs: KeyRef[], mode: KeySelectMode) => void;
  /**
   * Dragging selected keys: seconds from where the drag started. With `snap`,
   * the grabbed key lands on a frame. `cancel` restores the keys.
   */
  onMoveKeys?: (deltaSeconds: number, phase: GesturePhase) => void;
  selectedRowId?: string | null;
  onSelectRow?: (rowId: string) => void;
  onToggleRow?: (rowId: string) => void;
  /** Right-click or long-press on a track list row. */
  onRowContextMenu?: (rowId: string, x: number, y: number) => void;
  /** Right-click or long-press on a key; the key is selected first unless it already is. */
  onKeyContextMenu?: (ref: KeyRef, x: number, y: number) => void;
  /**
   * Dragging the clip's end on the ruler (where the hatching starts). The
   * length is on a frame when `snap` is on; the caller clamps it.
   */
  onLengthChange?: (length: number, phase: GesturePhase) => void;
  /** Changing this number fits 0 s to the clip's end in the lanes again (Zoom To Fit). */
  fitToken?: number;
  /** Above the track list, beside the ruler (a filter field). */
  header?: ReactNode;
  /** Track list and lane row height; 24 px by default, 44 for touch. */
  rowHeight?: number;
  "aria-label": string;
  className?: string;
  "data-testid"?: string;
}

/** The colour tokens the lanes draw with. */
const LANE_COLOR_TOKENS = {
  accent: "--accent",
  stripe: "--list-stripe",
  border: "--border",
  background: "--background",
  mutedForeground: "--muted-foreground",
  foreground: "--foreground",
  selection: "--selection",
} as const;

type LanePalette = Record<keyof typeof LANE_COLOR_TOKENS, string>;

function resolveLanePalette(element: Element): LanePalette {
  const style = getComputedStyle(element);
  const palette = {} as LanePalette;
  for (const [name, token] of Object.entries(LANE_COLOR_TOKENS) as [keyof LanePalette, string][]) {
    palette[name] = style.getPropertyValue(token).trim() || "#888";
  }
  return palette;
}

/** What the canvas draws of a row: everything but its track list label, value and actions. */
type LaneRow = Pick<KeyframeTimelineRow, "id" | "kind" | "keys" | "connect" | "gradient" | "muted">;

function sameLaneRows(a: readonly LaneRow[], b: readonly LaneRow[]): boolean {
  return a.length === b.length && a.every((row, index) => {
    const other = b[index]!;
    return row.id === other.id && row.kind === other.kind && row.keys === other.keys &&
      row.connect === other.connect && row.gradient === other.gradient && row.muted === other.muted;
  });
}

/**
 * Calls `onChange` when the theme may have changed its colour tokens: the
 * root element's class, theme or style, a stylesheet added, removed or
 * rewritten in the document head (the editor theme is one), or the system
 * colour scheme.
 */
function observeTheme(onChange: () => void): () => void {
  const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  scheme?.addEventListener?.("change", onChange);
  if (typeof MutationObserver === "undefined") return () => scheme?.removeEventListener?.("change", onChange);
  const root = new MutationObserver(onChange);
  root.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  const isStylesheet = (node: Node) => node.nodeName === "STYLE" || node.nodeName === "LINK";
  const head = new MutationObserver((records) => {
    const changed = records.some((record) =>
      isStylesheet(record.target) || (record.target.parentNode !== null && isStylesheet(record.target.parentNode)) ||
      [...record.addedNodes, ...record.removedNodes].some(isStylesheet));
    if (changed) onChange();
  });
  head.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => {
    scheme?.removeEventListener?.("change", onChange);
    root.disconnect();
    head.disconnect();
  };
}

const RULER_PX = 24;
const TRACK_LIST_WIDTH_PX = 264;
const DRAG_PX = 4;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;
/** Each Zoom In or Zoom Out press. */
const ZOOM_STEP = 1.5;

type Press =
  | {
    kind: "key"; pointerId: number; x: number; y: number; ref: KeyRef; grabTime: number; moving: boolean; delta: number;
    holdTimer: number | null;
    /** A finger on an unselected key selects it only on a tap or a drag, so a hold can add it from the menu. */
    pendingSelect: boolean;
  }
  | { kind: "marquee"; pointerId: number; x: number; y: number; mode: KeySelectMode; active: boolean }
  | { kind: "pan"; pointerId: number; x: number; y: number; scrollTop: number; view: KeyframeTimelineView; holdTimer: number | null; moved: boolean };

/** A drag on the scroll bar, measured from the view, range and thumb it started with. */
interface ScrollDrag {
  pointerId: number;
  x: number;
  mode: "thumb" | "start" | "end";
  view: KeyframeTimelineView;
  range: KeyframeTimeRange;
  thumb: KeyframeScrollThumb;
}

/**
 * A keyframe editor: a track list beside a time ruler and canvas-drawn key
 * lanes that share one vertical scroll. Rows are groups (objects, whose lane
 * sums their tracks' keys) or tracks. The canvas draws shapes only; labels,
 * values, the ruler and the playhead line are HTML. Colours are CSS custom
 * properties, read once per theme change; the lanes redraw when it changes.
 *
 * Mouse: drag the ruler to scrub, or the clip's end on it to change the
 * length; click a key to select it (Shift adds, Ctrl/⌘ toggles) and drag to
 * move the selection (Alt leaves the frame grid); right-click a key for its
 * menu; drag empty lane space to marquee; Ctrl/⌘+wheel zooms and Shift+wheel
 * pans. Touch: tap selects, drag a key to move it, hold a key for its menu,
 * drag empty space to scroll and pan, hold then move to marquee, and pinch to
 * zoom. The lanes fill the window below the last row, so a marquee can start
 * there. A row below them pans and zooms the time scale: Zoom Out and Zoom In
 * about the playhead, and a scroll bar whose thumb drags to pan and whose
 * ends drag to zoom.
 */
export function KeyframeTimeline({
  rows,
  length,
  frameRate,
  time,
  onTimeChange,
  snap = true,
  selectedKeys,
  onSelectKeys,
  onMoveKeys,
  selectedRowId = null,
  onSelectRow,
  onToggleRow,
  onRowContextMenu,
  onKeyContextMenu,
  onLengthChange,
  fitToken,
  header,
  rowHeight = 24,
  "aria-label": ariaLabel,
  className,
  "data-testid": testId,
}: KeyframeTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [laneWidth, setLaneWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [laneHeight, setLaneHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [themeRevision, setThemeRevision] = useState(0);
  // Null follows the clip: 0 s to its length fill the lanes.
  const [zoomed, setZoomed] = useState<KeyframeTimelineView | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const press = useRef<Press | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; view: KeyframeTimelineView; centre: number } | null>(null);
  const ruler = useRef<{ pointerId: number; mode: "scrub" | "length"; length: number } | null>(null);
  const scrollDrag = useRef<ScrollDrag | null>(null);
  const lanesId = useId();

  const fitted = useMemo(() => fitKeyframeView(length, laneWidth), [length, laneWidth]);
  const view = zoomed ?? fitted;
  const contentHeight = rows.length * rowHeight;
  const ticks = useMemo(() => (laneWidth > 0 ? rulerTicks(view, laneWidth, frameRate) : []), [view, laneWidth, frameRate]);
  const coarse = rowHeight >= 40;

  useEffect(() => {
    const lanes = lanesRef.current;
    const scroller = scrollRef.current;
    if (!lanes || !scroller) return;
    const measure = () => {
      setLaneWidth(lanes.clientWidth);
      setLaneHeight(lanes.clientHeight);
      setViewportHeight(scroller.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(lanes);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // A new clip length refits the lanes, except while its end is being dragged; so does Zoom To Fit.
  useEffect(() => {
    if (ruler.current?.mode !== "length") setZoomed(null);
  }, [length]);
  useEffect(() => setZoomed(null), [fitToken]);

  // The colours are tokens: read them again and redraw when the theme changes.
  useEffect(() => observeTheme(() => setThemeRevision((revision) => revision + 1)), []);
  const palette = useRef<{ revision: number; colors: LanePalette } | null>(null);

  // What the canvas draws of the rows. It keeps its identity while only the
  // track list's values change, so a playhead move leaves the canvas alone.
  const lanes = useRef<readonly LaneRow[]>(rows);
  if (lanes.current !== rows && !sameLaneRows(lanes.current, rows)) lanes.current = rows;
  const laneRows = lanes.current;

  // Ctrl/⌘+wheel zooms and Shift+wheel pans; React's wheel listener is passive, so this one is native.
  useEffect(() => {
    const lanes = lanesRef.current;
    if (!lanes) return;
    const onWheel = (event: WheelEvent) => {
      const x = event.clientX - lanes.getBoundingClientRect().left;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoomed((current) => zoomKeyframeView(current ?? fitted, Math.exp(-event.deltaY * 0.002), x));
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
        setZoomed((current) => panKeyframeView(current ?? fitted, -dx));
      }
    };
    lanes.addEventListener("wheel", onWheel, { passive: false });
    return () => lanes.removeEventListener("wheel", onWheel);
  }, [fitted]);

  // The canvas sticks to the top of the scroller, and the lanes column is at
  // least as tall as the track list, so the canvas always starts at scrollTop.
  const drawHeight = Math.max(0, Math.min(viewportHeight, Math.max(laneHeight, contentHeight)));
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || laneWidth <= 0 || drawHeight <= 0) return;
    const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    // Resizing reallocates and clears the bitmap, so only a new size does it.
    const width = Math.round(laneWidth * ratio);
    const height = Math.round(drawHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (palette.current?.revision !== themeRevision) {
      palette.current = { revision: themeRevision, colors: resolveLanePalette(canvas) };
    }
    const color = palette.current.colors;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, laneWidth, drawHeight);
    const x = (seconds: number) => timeToX(view, seconds);
    const end = x(length);
    const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight));
    const lastRow = Math.min(laneRows.length - 1, Math.floor((scrollTop + drawHeight) / rowHeight));

    // Row backgrounds and separators.
    for (let index = firstRow; index <= lastRow; index++) {
      const row = laneRows[index]!;
      const top = index * rowHeight - scrollTop;
      if (row.id === selectedRowId) {
        context.fillStyle = color.accent;
        context.fillRect(0, top, laneWidth, rowHeight);
      } else if (row.kind === "group") {
        context.fillStyle = color.stripe;
        context.fillRect(0, top, laneWidth, rowHeight);
      }
      context.fillStyle = color.border;
      context.fillRect(0, top + rowHeight - 1, laneWidth, 1);
    }
    // Labelled seconds as faint lines.
    context.globalAlpha = 0.5;
    context.fillStyle = color.border;
    for (const tick of ticks) if (tick.label) context.fillRect(Math.round(x(tick.time)), 0, 1, drawHeight);
    context.globalAlpha = 1;
    // After the clip's end.
    if (end < laneWidth) {
      context.fillStyle = color.background;
      context.globalAlpha = 0.6;
      context.fillRect(Math.max(0, end), 0, laneWidth - Math.max(0, end), drawHeight);
      context.globalAlpha = 0.35;
      context.strokeStyle = color.border;
      context.lineWidth = 1;
      context.save();
      context.beginPath();
      context.rect(Math.max(0, end), 0, laneWidth, drawHeight);
      context.clip();
      context.beginPath();
      for (let offset = Math.max(0, end) - drawHeight; offset < laneWidth; offset += 8) {
        context.moveTo(offset, drawHeight);
        context.lineTo(offset + drawHeight, 0);
      }
      context.stroke();
      context.restore();
      context.globalAlpha = 1;
    }

    const keySize = coarse ? 12 : 9;
    for (let index = firstRow; index <= lastRow; index++) {
      const row = laneRows[index]!;
      const centre = index * rowHeight - scrollTop + rowHeight / 2;
      const labelled = row.keys.some((key) => key.label);
      const sorted = (row.connect && row.keys.length > 1) || labelled ? [...row.keys].sort((a, b) => a.time - b.time) : row.keys;
      context.globalAlpha = row.muted ? 0.4 : 1;
      if (row.gradient && row.gradient.length > 0) {
        const barHeight = Math.min(rowHeight - 10, 12);
        const left = Math.max(0, x(0));
        const right = Math.min(laneWidth, end);
        if (right > left) {
          const gradient = context.createLinearGradient(x(0), 0, end, 0);
          const span = Math.max(length, 1e-6);
          for (const stop of row.gradient) gradient.addColorStop(Math.min(1, Math.max(0, stop.time / span)), stop.color);
          context.fillStyle = gradient;
          context.fillRect(left, centre - barHeight / 2, right - left, barHeight);
        }
      } else if (row.connect && row.keys.length > 1) {
        context.fillStyle = color.mutedForeground;
        const from = x(sorted[0]!.time);
        const to = x(sorted[sorted.length - 1]!.time);
        context.fillRect(from, Math.round(centre), to - from, 1);
      }
      const size = row.kind === "group" ? keySize - 2 : keySize;
      if (labelled) {
        context.font = "10px ui-sans-serif, system-ui, sans-serif";
        context.textBaseline = "middle";
        context.fillStyle = color.mutedForeground;
        sorted.forEach((key, order) => {
          if (!key.label) return;
          const left = x(key.time) + size / 2 + 3;
          const right = Math.min(laneWidth, order + 1 < sorted.length ? x(sorted[order + 1]!.time) - size / 2 - 3 : end);
          if (right - left < 12 || left > laneWidth) return;
          context.save();
          context.beginPath();
          context.rect(left, centre - rowHeight / 2, right - left, rowHeight);
          context.clip();
          context.fillText(key.label, left, centre);
          context.restore();
        });
      }
      for (const key of row.keys) {
        const kx = x(key.time);
        if (kx < -size || kx > laneWidth + size) continue;
        const selected = selectedKeys.has(keyRefId({ rowId: row.id, keyId: key.id }));
        context.fillStyle = selected ? color.selection : row.kind === "group" ? color.mutedForeground : color.foreground;
        context.strokeStyle = color.background;
        context.lineWidth = 1.5;
        drawKey(context, key.shape, kx, centre, size);
      }
      context.globalAlpha = 1;
    }

    if (marquee) {
      const top = marquee.top - scrollTop;
      context.fillStyle = color.selection;
      context.globalAlpha = 0.12;
      context.fillRect(marquee.left, top, marquee.right - marquee.left, marquee.bottom - marquee.top);
      context.globalAlpha = 0.8;
      context.strokeStyle = color.selection;
      context.lineWidth = 1;
      context.strokeRect(marquee.left + 0.5, top + 0.5, marquee.right - marquee.left - 1, marquee.bottom - marquee.top - 1);
      context.globalAlpha = 1;
    }
  }, [laneRows, view, ticks, laneWidth, drawHeight, scrollTop, rowHeight, selectedKeys, selectedRowId, length, marquee, coarse, themeRevision]);

  const lanePoint = (event: { clientX: number; clientY: number }) => {
    const rect = lanesRef.current!.getBoundingClientRect();
    // The lanes column is as tall as every row, so y is already in content space.
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const snapped = (seconds: number) => (snap ? snapToFrame(seconds, frameRate, length) : Math.min(length, Math.max(0, seconds)));

  const endPress = (phase: "end" | "cancel") => {
    const held = press.current;
    press.current = null;
    if (!held) return;
    if ((held.kind === "pan" || held.kind === "key") && held.holdTimer !== null) clearTimeout(held.holdTimer);
    if (held.kind === "key" && held.moving) onMoveKeys?.(phase === "cancel" ? 0 : held.delta, phase);
    if (held.kind === "marquee") setMarquee(null);
  };

  const onLanePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      // A second finger cancels the press and pinches the time scale.
      endPress("cancel");
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.max(1, Math.abs(a!.x - b!.x)),
        view,
        centre: (a!.x + b!.x) / 2 - lanesRef.current!.getBoundingClientRect().left,
      };
      return;
    }
    if (pointers.current.size > 2) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const point = lanePoint(event);
    const row = rows[Math.floor(point.y / rowHeight)];
    const touch = event.pointerType !== "mouse";
    const key = keyAt(row, view, point.x, keyReach(touch || coarse));
    const mode: KeySelectMode = event.shiftKey ? "add" : event.ctrlKey || event.metaKey ? "toggle" : "replace";
    if (row && key) {
      const ref = { rowId: row.id, keyId: key.id };
      const unselected = !selectedKeys.has(keyRefId(ref));
      const pendingSelect = touch && Boolean(onKeyContextMenu) && mode === "replace" && unselected;
      if (!pendingSelect && (mode !== "replace" || unselected)) onSelectKeys([ref], mode);
      const keyPress: Press = {
        kind: "key", pointerId: event.pointerId, x: event.clientX, y: event.clientY, ref, grabTime: key.time,
        moving: false, delta: 0, holdTimer: null, pendingSelect,
      };
      // A finger held still on a key opens its menu instead of dragging it.
      if (touch && onKeyContextMenu) {
        keyPress.holdTimer = window.setTimeout(() => {
          if (press.current !== keyPress || keyPress.moving) return;
          press.current = null;
          onKeyContextMenu(ref, keyPress.x, keyPress.y);
        }, LONG_PRESS_MS);
      }
      press.current = keyPress;
      return;
    }
    if (!touch) {
      press.current = { kind: "marquee", pointerId: event.pointerId, x: point.x, y: point.y, mode, active: false };
      return;
    }
    const scroller = scrollRef.current!;
    const pan: Press = { kind: "pan", pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollTop: scroller.scrollTop, view, holdTimer: null, moved: false };
    // Hold, then move: marquee.
    pan.holdTimer = window.setTimeout(() => {
      if (press.current !== pan || pan.moved) return;
      press.current = { kind: "marquee", pointerId: event.pointerId, x: point.x, y: point.y, mode: "replace", active: false };
    }, LONG_PRESS_MS);
    press.current = pan;
  };

  const onLanePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.max(1, Math.abs(a!.x - b!.x));
      setZoomed(zoomKeyframeView(pinch.current.view, distance / pinch.current.distance, pinch.current.centre));
      return;
    }
    const held = press.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (held.kind === "key") {
      const slop = event.pointerType === "mouse" ? DRAG_PX : LONG_PRESS_SLOP_PX;
      if (!held.moving && Math.abs(event.clientX - held.x) <= slop) return;
      if (held.holdTimer !== null) {
        clearTimeout(held.holdTimer);
        held.holdTimer = null;
      }
      if (held.pendingSelect) {
        // Select first; the move starts with the next event, once the selection includes the key.
        held.pendingSelect = false;
        onSelectKeys([held.ref], "replace");
        return;
      }
      if (!onMoveKeys) return;
      if (!held.moving) {
        held.moving = true;
        onMoveKeys(0, "start");
      }
      const raw = (event.clientX - held.x) / view.pixelsPerSecond;
      // Alt moves keys off the frame grid.
      held.delta = snap && !event.altKey ? snapToFrame(held.grabTime + raw, frameRate, Number.POSITIVE_INFINITY) - held.grabTime : raw;
      onMoveKeys(held.delta, "move");
      return;
    }
    if (held.kind === "pan") {
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
      if (!held.moved && Math.hypot(dx, dy) <= LONG_PRESS_SLOP_PX) return;
      held.moved = true;
      scrollRef.current!.scrollTop = held.scrollTop - dy;
      if (zoomed) setZoomed(panKeyframeView(held.view, dx));
      return;
    }
    const point = lanePoint(event);
    if (!held.active && Math.hypot(point.x - held.x, point.y - held.y) <= DRAG_PX) return;
    held.active = true;
    setMarquee({
      left: Math.min(held.x, point.x), right: Math.max(held.x, point.x),
      top: Math.min(held.y, point.y), bottom: Math.max(held.y, point.y),
    });
  };

  const onLanePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      return;
    }
    const held = press.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (held.kind === "key") {
      if (held.pendingSelect) onSelectKeys([held.ref], "replace");
      else if (!held.moving) {
        // A click on a key of a group selected with others selects it alone.
        const point = lanePoint(event);
        const row = rows[Math.floor(point.y / rowHeight)];
        const key = keyAt(row, view, point.x, keyReach(event.pointerType !== "mouse" || coarse));
        const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey;
        if (row && key && plain && selectedKeys.size > 1) onSelectKeys([{ rowId: row.id, keyId: key.id }], "replace");
      }
      endPress("end");
      return;
    }
    if (held.kind === "marquee") {
      const point = lanePoint(event);
      if (held.active) {
        const rect = {
          left: Math.min(held.x, point.x), right: Math.max(held.x, point.x),
          top: Math.min(held.y, point.y), bottom: Math.max(held.y, point.y),
        };
        onSelectKeys(keysInRect(rows, rowHeight, view, rect), held.mode === "replace" ? "replace" : "add");
      } else if (held.mode === "replace") {
        onSelectKeys([], "replace");
      }
      endPress("end");
      return;
    }
    // A tap on empty lane space clears the key selection.
    if (!held.moved) onSelectKeys([], "replace");
    endPress("end");
  };

  const onLanePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (press.current?.pointerId === event.pointerId) endPress("cancel");
  };

  const rulerX = (event: { clientX: number }) => event.clientX - lanesRef.current!.getBoundingClientRect().left;
  const rulerTime = (event: { clientX: number; altKey?: boolean }) => {
    const seconds = xToTime(view, rulerX(event));
    return snap && !event.altKey ? snapToFrame(seconds, frameRate, length) : Math.min(length, Math.max(0, seconds));
  };
  const rulerLength = (event: { clientX: number; altKey?: boolean }) => {
    const seconds = Math.max(0, xToTime(view, rulerX(event)));
    return snap && !event.altKey ? snapToFrame(seconds, frameRate, Number.POSITIVE_INFINITY) : seconds;
  };
  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const onEnd = onLengthChange && Math.abs(rulerX(event) - timeToX(view, length)) <= keyReach(event.pointerType !== "mouse" || coarse);
    if (onEnd) {
      // The lanes keep their scale while the end moves, so the edge follows the pointer.
      setZoomed(view);
      ruler.current = { pointerId: event.pointerId, mode: "length", length };
      onLengthChange(length, "start");
      return;
    }
    ruler.current = { pointerId: event.pointerId, mode: "scrub", length };
    onTimeChange(rulerTime(event), "start");
  };
  const onRulerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = ruler.current;
    if (held?.pointerId !== event.pointerId) return;
    if (held.mode === "length") {
      held.length = rulerLength(event);
      onLengthChange?.(held.length, "move");
    } else onTimeChange(rulerTime(event), "move");
  };
  const onRulerPointerEnd = (event: ReactPointerEvent<HTMLDivElement>, phase: "end" | "cancel") => {
    const held = ruler.current;
    if (held?.pointerId !== event.pointerId) return;
    ruler.current = null;
    if (held.mode === "length") {
      onLengthChange?.(held.length, phase);
      setZoomed(null);
    } else onTimeChange(rulerTime(event), phase);
  };
  const onLaneContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onKeyContextMenu) return;
    const point = lanePoint(event);
    const row = rows[Math.floor(point.y / rowHeight)];
    const key = keyAt(row, view, point.x, keyReach(coarse));
    if (!row || !key) return;
    event.preventDefault();
    const ref = { rowId: row.id, keyId: key.id };
    if (!selectedKeys.has(keyRefId(ref))) onSelectKeys([ref], "replace");
    onKeyContextMenu(ref, event.clientX, event.clientY);
  };

  const endX = timeToX(view, length);
  const playheadX = timeToX(view, time);
  const gridStyle: CSSProperties = { gridTemplateColumns: `${TRACK_LIST_WIDTH_PX}px minmax(0, 1fr)` };

  // Zoom Out and Zoom In keep the playhead where it is, or the lanes' middle when it is out of view.
  const zoomAnchor = playheadX >= 0 && playheadX <= laneWidth ? playheadX : laneWidth / 2;
  const zoomedBy = (factor: number) => zoomKeyframeView(view, factor, zoomAnchor);
  const canZoomIn = laneWidth > 0 && zoomedBy(ZOOM_STEP).pixelsPerSecond > view.pixelsPerSecond;
  const canZoomOut = laneWidth > 0 && zoomedBy(1 / ZOOM_STEP).pixelsPerSecond < view.pixelsPerSecond;

  // The scroll bar spans the lanes' width, below them.
  const scrollRange = keyframeScrollRange(view, laneWidth, length);
  const thumb = keyframeScrollThumb(view, laneWidth, scrollRange, laneWidth, coarse ? 66 : 24);
  const gripWidth = Math.min(keyReach(coarse), thumb.width / 3);
  const visibleSeconds = laneWidth / view.pixelsPerSecond;
  const scrollable = scrollRange.end - scrollRange.start - visibleSeconds;
  const scrollPercent = scrollable > 1e-9 ? Math.round(((view.start - scrollRange.start) / scrollable) * 100) : 0;
  const scrollTo = (start: number) => setZoomed({
    ...view,
    start: Math.min(scrollRange.start + Math.max(0, scrollable), Math.max(scrollRange.start, start)),
  });
  const onScrollPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.pointerType === "mouse" && event.button !== 0) || laneWidth <= 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const hit = keyframeScrollHit(thumb, x, keyReach(event.pointerType !== "mouse" || coarse));
    let start = view;
    if (hit === "track") {
      // A press beside the thumb brings its middle there, then drags it.
      start = scrollKeyframeView(view, laneWidth, scrollRange, laneWidth, thumb, x - (thumb.left + thumb.width / 2));
      setZoomed(start);
    }
    scrollDrag.current = { pointerId: event.pointerId, x, mode: hit === "track" ? "thumb" : hit, view: start, range: scrollRange, thumb };
  };
  const onScrollPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = scrollDrag.current;
    if (held?.pointerId !== event.pointerId) return;
    const dx = event.clientX - event.currentTarget.getBoundingClientRect().left - held.x;
    setZoomed(held.mode === "thumb"
      ? scrollKeyframeView(held.view, laneWidth, held.range, laneWidth, held.thumb, dx)
      : resizeKeyframeView(held.view, laneWidth, held.range, laneWidth, held.mode, dx));
  };
  const onScrollPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollDrag.current?.pointerId === event.pointerId) scrollDrag.current = null;
  };

  return (
    <div className={cn("grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] bg-background text-xs", className)} style={gridStyle} data-testid={testId}>
      <div className="flex items-center border-r border-b px-1" style={{ height: RULER_PX }}>{header}</div>
      <div
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={length}
        aria-valuenow={Number(time.toFixed(3))}
        aria-valuetext={`${time.toFixed(2)} s`}
        tabIndex={0}
        data-testid="keyframe-timeline-ruler"
        className="relative cursor-ew-resize touch-none overflow-hidden border-b outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        style={{ height: RULER_PX }}
        onPointerDown={onRulerPointerDown}
        onPointerMove={onRulerPointerMove}
        onPointerUp={(event) => onRulerPointerEnd(event, "end")}
        onPointerCancel={(event) => onRulerPointerEnd(event, "cancel")}
        onKeyDown={(event) => {
          const frame = frameRate > 0 ? 1 / frameRate : 0.01;
          const next = event.key === "ArrowLeft" ? time - frame : event.key === "ArrowRight" ? time + frame
            : event.key === "Home" ? 0 : event.key === "End" ? length : null;
          if (next === null) return;
          event.preventDefault();
          onTimeChange(snapped(next), "end");
        }}
      >
        {endX < laneWidth ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_6px)] opacity-70"
            style={{ left: Math.max(0, endX) }}
          />
        ) : null}
        {onLengthChange && endX >= 0 && endX <= laneWidth ? (
          <div
            aria-hidden="true"
            data-testid="keyframe-timeline-end"
            className="absolute inset-y-0 w-2 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-muted-foreground"
            style={{ left: endX }}
          />
        ) : null}
        {ticks.map((tick) => (
          <div
            key={tick.time}
            aria-hidden="true"
            className={cn("absolute bottom-0 w-px bg-border", tick.label ? "h-2.5" : "h-1")}
            style={{ left: Math.round(timeToX(view, tick.time)) }}
          >
            {tick.label ? <span className="absolute bottom-2.5 left-1 font-mono text-[10px] whitespace-nowrap text-muted-foreground tabular-nums">{tick.label}</span> : null}
          </div>
        ))}
        {playheadX >= -6 && playheadX <= laneWidth + 6 ? (
          <div aria-hidden="true" className="pointer-events-none absolute top-0 bottom-0" style={{ left: Math.round(playheadX) }}>
            <div className="absolute top-0 -left-[5px] h-2.5 w-[11px] rounded-b-[2px] bg-selection" />
            <div className="absolute top-0 bottom-0 left-0 w-px bg-selection" />
          </div>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        className="col-span-2 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {/* At least as tall as the window, so the lanes below the last row take a marquee. */}
        <div className="grid min-h-full" style={gridStyle}>
          <div role="tree" aria-label={`${ariaLabel} Tracks`} className="min-w-0 border-r">
            {rows.map((row) => (
              <MemoTrackListRow
                key={row.id}
                row={row}
                height={rowHeight}
                selected={row.id === selectedRowId}
                onSelect={onSelectRow}
                onToggle={onToggleRow}
                onContextMenu={onRowContextMenu}
              />
            ))}
          </div>
          <div
            ref={lanesRef}
            id={lanesId}
            role="group"
            aria-roledescription="keyframe lanes"
            aria-label={ariaLabel}
            tabIndex={0}
            data-testid="keyframe-timeline-lanes"
            className="relative min-w-0 touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{ minHeight: contentHeight }}
            onPointerDown={onLanePointerDown}
            onPointerMove={onLanePointerMove}
            onPointerUp={onLanePointerUp}
            onPointerCancel={onLanePointerCancel}
            onContextMenu={onLaneContextMenu}
          >
            <canvas
              ref={canvasRef}
              aria-hidden="true"
              className="pointer-events-none sticky top-0 left-0 block w-full"
              style={{ height: drawHeight }}
            />
            {Math.round(playheadX) >= 0 && Math.round(playheadX) <= laneWidth ? (
              <div
                aria-hidden="true"
                data-testid="keyframe-timeline-lane-playhead"
                className="pointer-events-none absolute inset-y-0 w-px bg-selection"
                style={{ left: Math.round(playheadX) }}
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-0.5 border-t border-r px-1" style={{ height: rowHeight }} data-testid="keyframe-timeline-zoom-controls">
        <Button type="button" variant="ghost" size={coarse ? "touch-icon" : "icon-xs"} aria-label="Zoom Out" disabled={!canZoomOut}
          onClick={() => setZoomed(zoomedBy(1 / ZOOM_STEP))} data-testid="keyframe-timeline-zoom-out">
          <ZoomOutIcon aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size={coarse ? "touch-icon" : "icon-xs"} aria-label="Zoom In" disabled={!canZoomIn}
          onClick={() => setZoomed(zoomedBy(ZOOM_STEP))} data-testid="keyframe-timeline-zoom-in">
          <ZoomInIcon aria-hidden="true" />
        </Button>
        <span className="px-1 font-mono text-[11px] text-muted-foreground tabular-nums" data-testid="keyframe-timeline-zoom">
          {`${Math.round(keyframeZoomFactor(view, fitted) * 100)}%`}
        </span>
      </div>
      <div
        role="scrollbar"
        aria-label="Scroll Time"
        aria-controls={lanesId}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={scrollPercent}
        tabIndex={0}
        data-testid="keyframe-timeline-scrollbar"
        className="relative touch-none overflow-hidden border-t outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        style={{ height: rowHeight }}
        onPointerDown={onScrollPointerDown}
        onPointerMove={onScrollPointerMove}
        onPointerUp={onScrollPointerEnd}
        onPointerCancel={onScrollPointerEnd}
        onKeyDown={(event) => {
          const step = visibleSeconds / 10;
          const next = event.key === "ArrowLeft" ? view.start - step : event.key === "ArrowRight" ? view.start + step
            : event.key === "Home" ? scrollRange.start : event.key === "End" ? scrollRange.end : null;
          if (next === null) return;
          event.preventDefault();
          scrollTo(next);
        }}
      >
        {laneWidth > 0 ? (
          <div aria-hidden="true" className="absolute inset-y-0 left-0" style={{ width: laneWidth }}>
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
            <div
              data-testid="keyframe-timeline-scroll-thumb"
              className={cn(
                "absolute top-1/2 -translate-y-1/2 cursor-grab rounded-sm bg-muted-foreground/40 hover:bg-muted-foreground/55 active:cursor-grabbing",
                coarse ? "h-5" : "h-3",
              )}
              style={{ left: thumb.left, width: thumb.width }}
            >
              {/* The ends resize the thumb, which zooms. */}
              {(["left-0", "right-0"] as const).map((side) => (
                <span key={side} className={cn("absolute inset-y-0 flex cursor-ew-resize items-center justify-center", side)} style={{ width: gripWidth }}>
                  <span className="h-2/3 w-px rounded-full bg-background/80" />
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TrackListRow({
  row,
  height,
  selected,
  onSelect,
  onToggle,
  onContextMenu,
}: {
  row: KeyframeTimelineTrackRow;
  height: number;
  selected: boolean;
  onSelect?: (rowId: string) => void;
  onToggle?: (rowId: string) => void;
  onContextMenu?: (rowId: string, x: number, y: number) => void;
}) {
  const hold = useRef<{ timer: number; x: number; y: number; pointerId: number } | null>(null);
  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => clearHold, []);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || !onContextMenu) return;
    const { clientX: x, clientY: y, pointerId } = event;
    clearHold();
    hold.current = { x, y, pointerId, timer: window.setTimeout(() => {
      hold.current = null;
      onSelect?.(row.id);
      onContextMenu(row.id, x, y);
    }, LONG_PRESS_MS) };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = hold.current;
    if (held && held.pointerId === event.pointerId && Math.hypot(event.clientX - held.x, event.clientY - held.y) > LONG_PRESS_SLOP_PX) clearHold();
  };
  const onContext = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onContextMenu) return;
    event.preventDefault();
    onSelect?.(row.id);
    onContextMenu(row.id, event.clientX, event.clientY);
  };
  const Chevron = row.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.expanded}
      data-testid={row.testId}
      className={cn(
        "group/row flex min-w-0 cursor-default items-center gap-1 border-b pr-1 touch-pan-y select-none",
        row.kind === "group" ? "bg-list-stripe font-semibold" : "",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        row.muted ? "opacity-50" : "",
      )}
      style={{ height, paddingLeft: 4 + row.depth * 14 }}
      onClick={() => onSelect?.(row.id)}
      onContextMenu={onContext}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
    >
      {row.expanded === undefined ? <span className="w-4 shrink-0" /> : (
        <button
          type="button"
          aria-label={row.expanded ? "Collapse" : "Expand"}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.(row.id);
          }}
        >
          <Chevron className="size-3.5" />
        </button>
      )}
      {row.icon ? <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-3.5">{row.icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.value !== undefined ? <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] font-normal text-muted-foreground tabular-nums">{row.value}</span> : null}
      {row.actions ? <span className="flex shrink-0 items-center">{row.actions}</span> : null}
    </div>
  );
}

/** Rows whose props are unchanged skip rendering, as most do on a playhead move. */
const MemoTrackListRow = memo(TrackListRow);

function drawKey(context: CanvasRenderingContext2D, shape: KeyframeShape, x: number, y: number, size: number) {
  const half = size / 2;
  context.beginPath();
  switch (shape) {
    case "circle":
      context.arc(x, y, half - 0.5, 0, Math.PI * 2);
      break;
    case "square":
      context.rect(x - half + 1, y - half + 1, size - 2, size - 2);
      break;
    case "hourglass":
      context.moveTo(x - half, y - half);
      context.lineTo(x + half, y - half);
      context.lineTo(x - half, y + half);
      context.lineTo(x + half, y + half);
      context.closePath();
      break;
    default:
      context.moveTo(x, y - half);
      context.lineTo(x + half, y);
      context.lineTo(x, y + half);
      context.lineTo(x - half, y);
      context.closePath();
  }
  context.fill();
  context.stroke();
}
