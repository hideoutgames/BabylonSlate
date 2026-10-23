import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@haptic/ui/lib/utils";
import {
  TIMELINE_BUCKET_PX,
  timelineBucket,
  timelineHit,
  timelineMarkerAt,
  timelinePeaks,
  timelineScale,
  timelineStep,
  timelineTotals,
  type TimelineDomain,
  type TimelineMarker,
  type TimelineTrack,
} from "./timeline-chart-model";

export type TimelineSelection = { track: string; index: number };

export type TimelineChartProps = {
  tracks: readonly TimelineTrack[];
  /** Drawn on their own row under the tracks. */
  markers?: readonly TimelineMarker[];
  domain: TimelineDomain;
  selected?: TimelineSelection | null;
  range?: TimelineDomain | null;
  onSelect?: (selection: TimelineSelection) => void;
  /** A drag across the chart selects a time range; Escape, or null, clears it. */
  onRangeChange?: (range: TimelineDomain | null) => void;
  formatTime?: (ms: number) => string;
  "aria-label": string;
  className?: string;
};

const TRACK_PX = 56;
const MARKER_PX = 18;
/** Pixels a press must move before it selects a range instead of a sample. */
const DRAG_PX = 4;
const defaultTime = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const withUnit = (text: string | number, unit: string) => `${text}${unit ? ` ${unit}` : ""}`;
const formatValue = (value: number, unit: string) => withUnit(Number.isInteger(value) ? value : value.toFixed(3), unit);

type Hover = { left: number; top: number; lines: string[] };

/**
 * Tracks of timed samples on one shared time axis, each on its own value scale: stacked bars (each
 * bar the slowest sample of its few pixels), a dashed budget line, a markers row, the selected
 * sample and a dragged time range. The canvas draws rectangles only; every label is text, so it
 * stays crisp and readable. A mouse hover names the sample; a tap or click selects it, and the
 * arrow keys step through its track. Colours come from CSS custom properties read on every draw,
 * so a theme change shows on the next one.
 */
export function TimelineChart({
  tracks,
  markers,
  domain,
  selected = null,
  range = null,
  onSelect,
  onRangeChange,
  formatTime = defaultTime,
  "aria-label": ariaLabel,
  className,
}: TimelineChartProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<TimelineDomain | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const press = useRef<{ pointerId: number; x: number; time: number; dragging: boolean } | null>(null);
  const height = tracks.length * TRACK_PX + (markers ? MARKER_PX : 0);
  const buckets = Math.max(1, Math.floor(width / TIMELINE_BUCKET_PX));
  const span = domain[1] - domain[0];

  const layout = useMemo(() => tracks.map((track) => {
    const totals = timelineTotals(track);
    const peaks = timelinePeaks(track.times, totals, domain, buckets);
    return { track, totals, peaks, scale: timelineScale(totals, peaks, track.threshold) };
  }), [tracks, domain, buckets]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    setWidth(plot.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(plot.clientWidth));
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);

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

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    const style = getComputedStyle(canvas);
    const color = (property: string) => style.getPropertyValue(property).trim() || "#888";
    const px = (value: number) => Math.round(value * ratio);
    const x = (time: number) => span > 0 ? (time - domain[0]) / span * width : 0;
    const bar = (TIMELINE_BUCKET_PX - 1);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const shade = (from: number, to: number, alpha: number) => {
      context.fillStyle = color("--trace-selected");
      context.globalAlpha = alpha;
      context.fillRect(px(Math.min(from, to)), 0, Math.max(px(1), px(Math.abs(to - from))), canvas.height);
      context.globalAlpha = 1;
    };
    const shown = drag ?? range;
    if (shown) shade(x(shown[0]), x(shown[1]), 0.15);

    layout.forEach(({ track, totals, peaks, scale }, row) => {
      const top = row * TRACK_PX;
      const base = top + TRACK_PX - 2;
      const plotHeight = TRACK_PX - 8;
      const y = (value: number) => base - value / scale * plotHeight;
      context.fillStyle = color("--border");
      context.fillRect(0, px(top + TRACK_PX - 1), canvas.width, px(1));
      const stack = (index: number, left: number, override?: string) => {
        let bottom = base;
        for (const segment of track.segments) {
          const value = segment.values[index]!;
          if (!Number.isFinite(value) || value <= 0) continue;
          const tall = value / scale * plotHeight;
          context.fillStyle = override ?? color(segment.color);
          // A 1px surface gap between stacked parts, where there is room for one.
          const gap = tall > 3 && override === undefined ? 1 : 0;
          context.fillRect(px(left), px(bottom - tall), px(bar), Math.max(px(1), px(tall - gap)));
          bottom -= tall;
        }
      };
      for (let bucket = 0; bucket < peaks.length; bucket++) {
        const index = peaks[bucket]!;
        if (index < 0) continue;
        stack(index, bucket * TIMELINE_BUCKET_PX);
        if (track.threshold !== undefined && totals[index]! > track.threshold) {
          context.fillStyle = color("--destructive");
          context.fillRect(px(bucket * TIMELINE_BUCKET_PX), px(y(totals[index]!)), px(bar), Math.max(px(1), px(y(track.threshold) - y(totals[index]!))));
        }
      }
      if (selected?.track === track.id && selected.index >= 0 && selected.index < track.times.length) {
        const bucket = timelineBucket(track.times[selected.index]!, domain, buckets);
        if (bucket >= 0) {
          context.fillStyle = color("--trace-selected");
          context.globalAlpha = 0.25;
          context.fillRect(px(bucket * TIMELINE_BUCKET_PX - 1), px(top), px(TIMELINE_BUCKET_PX + 1), px(TRACK_PX - 1));
          context.globalAlpha = 1;
          stack(selected.index, bucket * TIMELINE_BUCKET_PX, color("--trace-selected"));
        }
      }
      if (track.threshold !== undefined) {
        context.fillStyle = color("--destructive");
        const line = px(y(track.threshold));
        for (let dash = 0; dash < width; dash += 6) context.fillRect(px(dash), line, px(3), px(1));
      }
    });

    if (markers) {
      const top = tracks.length * TRACK_PX;
      for (const marker of markers) {
        const left = x(marker.atMs);
        const right = x(marker.endMs ?? marker.atMs);
        context.fillStyle = color(marker.color);
        context.fillRect(px(left), px(top + 4), Math.max(px(2), px(right - left)), px(MARKER_PX - 8));
      }
    }
    // themeRevision: the colours were read again for the new theme.
  }, [layout, markers, domain, buckets, width, height, span, selected, range, drag, tracks.length, themeRevision]);

  const locate = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const offsetY = event.clientY - rect.top;
    const plotWidth = rect.width || width || 1;
    return {
      offsetX,
      offsetY,
      time: domain[0] + offsetX / plotWidth * span,
      bucket: Math.min(buckets - 1, Math.floor(offsetX / plotWidth * buckets)),
      row: Math.floor(offsetY / TRACK_PX),
    };
  };
  const sampleAt = (point: ReturnType<typeof locate>) => {
    const entry = layout[point.row];
    if (!entry) return null;
    const index = timelineHit(entry.peaks, point.bucket);
    return index < 0 ? null : { entry, index };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    press.current = { pointerId: event.pointerId, x: event.clientX, time: locate(event).time, dragging: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = press.current;
    if (held && held.pointerId === event.pointerId) {
      if (!held.dragging && Math.abs(event.clientX - held.x) > DRAG_PX && onRangeChange) held.dragging = true;
      if (held.dragging) {
        const time = locate(event).time;
        setDrag([Math.min(held.time, time), Math.max(held.time, time)]);
      }
      return;
    }
    if (event.pointerType !== "mouse") return;
    const point = locate(event);
    const hit = sampleAt(point);
    const marker = markers && point.row === tracks.length
      ? timelineMarkerAt(markers, point.time, span / Math.max(1, width) * 4)
      : null;
    const lines = hit ? sampleLines(hit.entry.track, hit.index, hit.entry.totals[hit.index]!, formatTime)
      : marker ? [marker.label, marker.endMs === undefined ? formatTime(marker.atMs) : `${formatTime(marker.atMs)} – ${formatTime(marker.endMs)}`]
        : null;
    setHover(lines ? { left: point.offsetX, top: point.offsetY, lines } : null);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const held = press.current;
    if (!held || held.pointerId !== event.pointerId) return;
    press.current = null;
    if (held.dragging) {
      const time = locate(event).time;
      setDrag(null);
      onRangeChange?.([Math.min(held.time, time), Math.max(held.time, time)]);
      return;
    }
    const hit = sampleAt(locate(event));
    if (hit) onSelect?.({ track: hit.entry.track.id, index: hit.index });
  };
  const cancel = () => {
    press.current = null;
    setDrag(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && range) {
      event.preventDefault();
      onRangeChange?.(null);
      return;
    }
    if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || !selected) return;
    const track = tracks.find((entry) => entry.id === selected.track);
    if (!track) return;
    event.preventDefault();
    onSelect?.({ track: track.id, index: timelineStep(track.times, selected.index, event.key === "ArrowLeft" ? -1 : 1) });
  };

  return (
    <div className={cn("flex flex-col border-b bg-background text-[10px] text-muted-foreground", className)} data-testid="timeline-chart">
      <div className="flex">
        <div className="w-24 shrink-0 border-r" aria-hidden="true">
          {layout.map(({ track, scale }) => (
            <div key={track.id} className="relative flex flex-col justify-between border-b px-1.5 py-1" style={{ height: TRACK_PX }}>
              <span className="truncate text-[11px] font-medium text-foreground">{track.label}</span>
              <span className="font-mono tabular-nums">{withUnit(Number((scale / 1.1).toFixed(1)), track.unit)}</span>
            </div>
          ))}
          {markers ? <div className="flex items-center px-1.5 text-[11px] font-medium text-foreground" style={{ height: MARKER_PX }}>Markers</div> : null}
        </div>
        <div
          ref={plotRef}
          role="group"
          aria-roledescription="timeline chart"
          aria-label={ariaLabel}
          tabIndex={0}
          className="relative min-w-0 flex-1 cursor-crosshair touch-pan-y outline-none select-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
        >
          <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />
          {hover ? (
            <div
              role="tooltip"
              data-testid="timeline-chart-tip"
              className="pointer-events-none absolute z-10 max-w-64 rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md"
              style={{ left: Math.min(hover.left + 12, Math.max(0, width - 200)), top: Math.max(0, hover.top - 8) }}
            >
              {hover.lines.map((line, index) => <div key={index} className={index === 0 ? "font-medium" : "font-mono tabular-nums"}>{line}</div>)}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex justify-between py-0.5 pr-1 pl-25 font-mono tabular-nums" aria-hidden="true">
        <span>{formatTime(domain[0])}</span>
        {range ? <span className="text-foreground">{formatTime(range[0])} – {formatTime(range[1])}</span> : null}
        <span>{formatTime(domain[1])}</span>
      </div>
    </div>
  );
}

/** A sample's tip: its track and time, each stacked part, the total and whether it is over budget. */
function sampleLines(track: TimelineTrack, index: number, total: number, formatTime: (ms: number) => string): string[] {
  const lines = [`${track.label} · ${formatTime(track.times[index]!)}`];
  for (const segment of track.segments) {
    const value = segment.values[index]!;
    if (Number.isFinite(value)) lines.push(`${segment.label} ${formatValue(value, track.unit)}`);
  }
  if (track.segments.length > 1) lines.push(`Total ${formatValue(total, track.unit)}`);
  if (track.threshold !== undefined && total > track.threshold) lines.push("Over Budget");
  return lines;
}
