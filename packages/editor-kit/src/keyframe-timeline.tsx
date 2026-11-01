import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@haptic/ui/lib/utils";
import {
  fitKeyframeView,
  keyAt,
  keyReach,
  keyRefId,
  keysInRect,
  panKeyframeView,
  rulerTicks,
  snapToFrame,
  timeToX,
  xToTime,
  zoomKeyframeView,
  type KeyRef,
  type KeyframeShape,
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
  /** Below the last track list row (Add Track). */
  footer?: ReactNode;
  /** Track list and lane row height; 24 px by default, 44 for touch. */
  rowHeight?: number;
  trackListWidth?: number;
  "aria-label": string;
  className?: string;
  "data-testid"?: string;
}

const RULER_PX = 24;
const DRAG_PX = 4;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

type Press =
  | {
    kind: "key"; pointerId: number; x: number; y: number; ref: KeyRef; grabTime: number; moving: boolean; delta: number;
    holdTimer: number | null;
    /** A finger on an unselected key selects it only on a tap or a drag, so a hold can add it from the menu. */
    pendingSelect: boolean;
  }
  | { kind: "marquee"; pointerId: number; x: number; y: number; mode: KeySelectMode; active: boolean }
  | { kind: "pan"; pointerId: number; x: number; y: number; scrollTop: number; view: KeyframeTimelineView; holdTimer: number | null; moved: boolean };

/**
 * A keyframe editor: a track list beside a time ruler and canvas-drawn key
 * lanes that share one vertical scroll. Rows are groups (objects, whose lane
 * sums their tracks' keys) or tracks. The canvas draws shapes only; labels,
 * values and the ruler are HTML. Colours are CSS custom properties read on
 * every draw.
 *
 * Mouse: drag the ruler to scrub, or the clip's end on it to change the
 * length; click a key to select it (Shift adds, Ctrl/⌘ toggles) and drag to
 * move the selection (Alt leaves the frame grid); right-click a key for its
 * menu; drag empty lane space to marquee; Ctrl/⌘+wheel zooms and Shift+wheel
 * pans. Touch: tap selects, drag a key to move it, hold a key for its menu,
 * drag empty space to scroll and pan, hold then move to marquee, and pinch to
 * zoom.
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
  footer,
  rowHeight = 24,
  trackListWidth = 264,
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

  // The colours are tokens: redraw when the theme or the system scheme changes.
  useEffect(() => {
    const redraw = () => setThemeRevision((revision) => revision + 1);
    const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener?.("change", redraw);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(redraw);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => {
      scheme?.removeEventListener?.("change", redraw);
      observer?.disconnect();
    };
  }, []);

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
    canvas.width = Math.round(laneWidth * ratio);
    canvas.height = Math.round(drawHeight * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    const style = getComputedStyle(canvas);
    const color = (property: string) => style.getPropertyValue(property).trim() || "#888";
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, laneWidth, drawHeight);
    const x = (seconds: number) => timeToX(view, seconds);
    const end = x(length);
    const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight));
    const lastRow = Math.min(rows.length - 1, Math.floor((scrollTop + drawHeight) / rowHeight));

    // Row backgrounds and separators.
    for (let index = firstRow; index <= lastRow; index++) {
      const row = rows[index]!;
      const top = index * rowHeight - scrollTop;
      if (row.id === selectedRowId) {
        context.fillStyle = color("--accent");
        context.fillRect(0, top, laneWidth, rowHeight);
      } else if (row.kind === "group") {
        context.fillStyle = color("--list-stripe");
        context.fillRect(0, top, laneWidth, rowHeight);
      }
      context.fillStyle = color("--border");
      context.fillRect(0, top + rowHeight - 1, laneWidth, 1);
    }
    // Labelled seconds as faint lines.
    context.globalAlpha = 0.5;
    context.fillStyle = color("--border");
    for (const tick of ticks) if (tick.label) context.fillRect(Math.round(x(tick.time)), 0, 1, drawHeight);
    context.globalAlpha = 1;
    // After the clip's end.
    if (end < laneWidth) {
      context.fillStyle = color("--background");
      context.globalAlpha = 0.6;
      context.fillRect(Math.max(0, end), 0, laneWidth - Math.max(0, end), drawHeight);
      context.globalAlpha = 0.35;
      context.strokeStyle = color("--border");
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
      const row = rows[index]!;
      const centre = index * rowHeight - scrollTop + rowHeight / 2;
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
        context.fillStyle = color("--muted-foreground");
        const sorted = [...row.keys].sort((a, b) => a.time - b.time);
        const from = x(sorted[0]!.time);
        const to = x(sorted[sorted.length - 1]!.time);
        context.fillRect(from, Math.round(centre), to - from, 1);
      }
      const size = row.kind === "group" ? keySize - 2 : keySize;
      if (row.keys.some((key) => key.label)) {
        const sorted = [...row.keys].sort((a, b) => a.time - b.time);
        context.font = "10px ui-sans-serif, system-ui, sans-serif";
        context.textBaseline = "middle";
        context.fillStyle = color("--muted-foreground");
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
        context.fillStyle = selected ? color("--selection") : row.kind === "group" ? color("--muted-foreground") : color("--foreground");
        context.strokeStyle = color("--background");
        context.lineWidth = 1.5;
        drawKey(context, key.shape, kx, centre, size);
      }
      context.globalAlpha = 1;
    }

    // Playhead.
    const playhead = Math.round(x(time));
    if (playhead >= 0 && playhead <= laneWidth) {
      context.fillStyle = color("--selection");
      context.fillRect(playhead, 0, 1, drawHeight);
    }
    if (marquee) {
      const top = marquee.top - scrollTop;
      context.fillStyle = color("--selection");
      context.globalAlpha = 0.12;
      context.fillRect(marquee.left, top, marquee.right - marquee.left, marquee.bottom - marquee.top);
      context.globalAlpha = 0.8;
      context.strokeStyle = color("--selection");
      context.lineWidth = 1;
      context.strokeRect(marquee.left + 0.5, top + 0.5, marquee.right - marquee.left - 1, marquee.bottom - marquee.top - 1);
      context.globalAlpha = 1;
    }
    // themeRevision: the colours were read again for the new theme.
  }, [rows, view, ticks, laneWidth, drawHeight, scrollTop, rowHeight, selectedKeys, selectedRowId, length, time, marquee, coarse, themeRevision]);

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
  const gridStyle: CSSProperties = { gridTemplateColumns: `${trackListWidth}px minmax(0, 1fr)` };

  return (
    <div className={cn("grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] bg-background text-xs", className)} style={gridStyle} data-testid={testId}>
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
        <div className="grid" style={gridStyle}>
          <div role="tree" aria-label={`${ariaLabel} Tracks`} className="min-w-0 border-r">
            {rows.map((row) => (
              <TrackListRow
                key={row.id}
                row={row}
                height={rowHeight}
                selected={row.id === selectedRowId}
                onSelect={onSelectRow}
                onToggle={onToggleRow}
                onContextMenu={onRowContextMenu}
              />
            ))}
            {footer}
          </div>
          <div
            ref={lanesRef}
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
          </div>
        </div>
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
