import {
  text2DFormattedUnits,
  parseText2DProperties,
  type RichTextEffects,
  type RichTextStyle,
  type Text2DAlignment,
  type Text2DProperties,
  type Text2DVerticalAlignment,
} from "@babylonslate/core";

export type GlyphSource = "bitmap" | "msdf";

export type GlyphMetrics = {
  width: number;
  height: number;
  bearingX: number;
  bearingY: number;
  advance: number;
  source: GlyphSource;
  /** Visible glyph bounds relative to the quad center, in world-space Y. */
  inkBounds?: { top: number; bottom: number };
  uvs?: { u0: number; v0: number; u1: number; v1: number };
};

export type GlyphMetricsProvider = {
  measureGlyph(ch: string, style: RichTextStyle): GlyphMetrics;
  measureImage(guid: string, sizePx: number): { width: number; height: number };
};

export type Text2DLayoutItem = {
  kind: "glyph" | "image" | "underline";
  ch?: string;
  guid?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: RichTextStyle;
  effects: RichTextEffects;
  source: GlyphSource;
  index: number;
  hoverPhase: number;
  rotatePhase: number;
  uvs?: GlyphMetrics["uvs"];
};

export type Text2DLayout = {
  items: Text2DLayoutItem[];
  width: number;
  height: number;
};

export type LayoutText2DInput = {
  text: string;
  rich: boolean;
  size: number;
  color: [number, number, number];
  alignment: Text2DAlignment;
  verticalAlignment?: Text2DVerticalAlignment;
  wrapWidth: number;
  wrapHeight?: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  outline: number;
  outlineColor: [number, number, number];
  /** Reveal underlines with their formatted character rather than the entire run. */
  separateUnderlines?: boolean;
  pixelsPerUnit: number;
  metrics: GlyphMetricsProvider;
};

type Pending = {
  kind: "glyph" | "image";
  ch?: string;
  guid?: string;
  width: number;
  height: number;
  advance: number;
  bearingX: number;
  bearingY: number;
  style: RichTextStyle;
  effects: RichTextEffects;
  source: GlyphSource;
  inkBounds?: GlyphMetrics["inkBounds"];
  uvs?: GlyphMetrics["uvs"];
  index: number;
};

const HOVER_SPEED = 2;
const ROTATE_SPEED = 2;
const SHAKE_SCALE = 0.03;
const SHAKE_SPEED = 8;

function shakeSample(index: number, seed: number): number {
  const value = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453123;
  return (value - Math.floor(value)) * 2 - 1;
}

function shakeNoise(time: number, seed: number): number {
  const step = Math.floor(time);
  const fraction = time - step;
  const blend = fraction * fraction * (3 - 2 * fraction);
  const start = shakeSample(step, seed);
  return start + (shakeSample(step + 1, seed) - start) * blend;
}

function emptyEffects(): RichTextEffects {
  return {
    shake: 0,
    waveSpeed: 0,
    waveIntensity: 0,
    hover: 0,
    rotate: 0,
  };
}

function hoverPhaseFor(index: number): number {
  return (index * 1.6180339887 + 0.37) % (Math.PI * 2);
}

function rotatePhaseFor(index: number): number {
  return (index * 2.3999632297 + 1.1) % (Math.PI * 2);
}

function unitsFrom(input: LayoutText2DInput) {
  const defaults: RichTextStyle = {
    bold: input.bold,
    italic: input.italic,
    underline: input.underline,
    color: [...input.color] as [number, number, number],
    size: input.size,
    outline: input.outline,
    outlineColor: [...input.outlineColor] as [number, number, number],
  };
  return text2DFormattedUnits(input.text, defaults, { rich: input.rich });
}

function lineShiftX(
  alignment: Text2DAlignment,
  lineWidth: number,
  wrapWorld: number,
): number {
  if (wrapWorld > 0) {
    if (alignment === "left") return -wrapWorld / 2;
    if (alignment === "right") return wrapWorld / 2 - lineWidth;
    return -lineWidth / 2;
  }
  return alignment === "center"
    ? -lineWidth / 2
    : alignment === "right"
      ? -lineWidth
      : 0;
}

function flushLine(
  line: Pending[],
  cursorY: number,
  alignment: Text2DAlignment,
  wrapWorld: number,
  items: Text2DLayoutItem[],
  separateUnderlines = false,
): { width: number; height: number } {
  if (line.length === 0) {
    return { width: 0, height: 0 };
  }
  const lineWidth = line.reduce((sum, entry) => sum + entry.advance, 0);
  const lineHeight = Math.max(...line.map((entry) => entry.height), 0);
  let inkTop = -Infinity;
  let inkBottom = Infinity;
  for (const entry of line) {
    if (entry.kind !== "glyph" || !entry.ch?.trim()) continue;
    inkTop = Math.max(inkTop, entry.bearingY + (entry.inkBounds?.top ?? entry.height / 2));
    inkBottom = Math.min(inkBottom, entry.bearingY + (entry.inkBounds?.bottom ?? -entry.height / 2));
  }
  const imageCenterY = Number.isFinite(inkTop) ? (inkTop + inkBottom) / 2 : 0;
  const shift = lineShiftX(alignment, lineWidth, wrapWorld);
  let cursorX = shift;
  for (const entry of line) {
    const x = cursorX + entry.bearingX + entry.width / 2;
    const y = cursorY + (entry.kind === "image" ? imageCenterY : entry.bearingY);
    items.push({
      kind: entry.kind,
      ch: entry.ch,
      guid: entry.guid,
      x,
      y,
      width: entry.width,
      height: entry.height,
      style: entry.style,
      effects: entry.effects,
      source: entry.source,
      index: entry.index,
      hoverPhase: hoverPhaseFor(entry.index),
      rotatePhase: rotatePhaseFor(entry.index),
      uvs: entry.uvs,
    });
    cursorX += entry.advance;
  }
  const underlineThickness = Math.max(lineHeight * 0.06, 0.004);
  const underlineY = cursorY - lineHeight / 2;
  let runStart: number | null = null;
  let runEnd = 0;
  let runStyle = line[0]!.style;
  let runIndex = line[0]!.index;
  const flushUnderline = () => {
    if (runStart === null) return;
    items.push({
      kind: "underline",
      x: (runStart + runEnd) / 2,
      y: underlineY,
      width: Math.max(runEnd - runStart, 0.001),
      height: underlineThickness,
      style: runStyle,
      effects: emptyEffects(),
      source: "bitmap",
      index: runIndex,
      hoverPhase: 0,
      rotatePhase: 0,
    });
    runStart = null;
  };
  cursorX = shift;
  for (const entry of line) {
    const left = cursorX + entry.bearingX;
    const right = left + entry.width;
    if (entry.style.underline) {
      if (runStart === null) {
        runStart = left;
        runStyle = entry.style;
        runIndex = entry.index;
      }
      runEnd = right;
      if (separateUnderlines) flushUnderline();
    } else {
      flushUnderline();
    }
    cursorX += entry.advance;
  }
  flushUnderline();
  return { width: lineWidth, height: lineHeight };
}

/** Layout glyph/image quads in world units (pixels / pixelsPerUnit). */
export function layoutText2D(input: LayoutText2DInput): Text2DLayout {
  const ppu = input.pixelsPerUnit > 0 ? input.pixelsPerUnit : 100;
  const wrapWorld = input.wrapWidth > 0 ? input.wrapWidth / ppu : 0;
  const wrapHeightWorld = input.wrapHeight && input.wrapHeight > 0 ? input.wrapHeight / ppu : 0;
  const vertical = input.verticalAlignment ?? "center";
  const items: Text2DLayoutItem[] = [];
  const lines: Array<{ pending: Pending[]; width: number; height: number }> = [];
  let line: Pending[] = [];
  let lineAdvance = 0;
  const defaultLineHeight = input.size / ppu;

  const breakLine = () => {
    const flushed = flushLine(line, 0, input.alignment, wrapWorld, []);
    lines.push({ pending: line, width: flushed.width, height: flushed.height || defaultLineHeight });
    line = [];
    lineAdvance = 0;
  };

  const pushPending = (entry: Pending) => {
    if (wrapWorld > 0 && lineAdvance > 0 && lineAdvance + entry.advance > wrapWorld) {
      breakLine();
    }
    line.push(entry);
    lineAdvance += entry.advance;
  };

  for (const span of unitsFrom(input)) {
    if (span.kind === "lineBreak") {
      breakLine();
      continue;
    }
    if (span.kind === "image") {
      const size = span.size > 0 ? span.size : input.size;
      const measured = input.metrics.measureImage(span.guid, size);
      pushPending({
        kind: "image",
        guid: span.guid,
        width: measured.width,
        height: measured.height,
        advance: measured.width,
        bearingX: 0,
        bearingY: 0,
        style: span.style,
        effects: span.effects,
        source: "bitmap",
        index: span.index,
      });
      continue;
    }
    const metrics = input.metrics.measureGlyph(span.ch, span.style);
    pushPending({
      kind: "glyph",
      ch: span.ch,
      width: metrics.width,
      height: metrics.height,
      advance: metrics.advance,
      bearingX: metrics.bearingX,
      bearingY: metrics.bearingY,
      style: span.style,
      effects: span.effects,
      source: metrics.source,
      inkBounds: metrics.inkBounds,
      uvs: metrics.uvs,
      index: span.index,
    });
  }
  if (line.length > 0 || lines.length === 0) breakLine();

  const totalHeight = lines.reduce((sum, entry) => sum + entry.height, 0);
  const totalWidth = Math.max(0, ...lines.map((entry) => entry.width));
  const frameHeight = wrapHeightWorld > 0 ? wrapHeightWorld : totalHeight;
  let cursorY =
    vertical === "top"
      ? frameHeight / 2
      : vertical === "bottom"
        ? -frameHeight / 2 + totalHeight
        : totalHeight / 2;
  for (const row of lines) {
    cursorY -= row.height / 2;
    flushLine(row.pending, cursorY, input.alignment, wrapWorld, items, input.separateUnderlines);
    cursorY -= row.height / 2;
  }
  return { items, width: totalWidth, height: totalHeight };
}

export function layoutText2DFromProperties(
  properties: unknown,
  options: {
    rich: boolean;
    pixelsPerUnit: number;
    metrics: GlyphMetricsProvider;
  },
): { parsed: Text2DProperties; layout: Text2DLayout } {
  const parsed = parseText2DProperties(properties, { rich: options.rich });
  return {
    parsed,
    layout: layoutText2D({
      text: parsed.text,
      rich: options.rich,
      size: parsed.size,
      color: parsed.color,
      alignment: parsed.alignment,
      verticalAlignment: parsed.verticalAlignment,
      wrapWidth: parsed.wrapWidth,
      wrapHeight: parsed.wrapHeight,
      bold: parsed.bold,
      italic: parsed.italic,
      underline: parsed.underline,
      outline: parsed.outline,
      outlineColor: parsed.outlineColor,
      separateUnderlines: options.rich && parsed.appearModes.length > 0,
      pixelsPerUnit: options.pixelsPerUnit,
      metrics: options.metrics,
    }),
  };
}

export type Text2DEffectSample = { x: number; y: number; rotation: number };

export type Text2DEffectContext = {
  time: number;
  index: number;
  fontSize: number;
  hoverPhase: number;
  rotatePhase: number;
  paused?: boolean;
  last?: Text2DEffectSample;
};

/** Stack shake / wave / hover / rotate in world units; `out` is filled and
 * returned when given, except while paused, which returns `context.last`. */
export function combineText2DEffects(
  effects: RichTextEffects,
  context: Text2DEffectContext,
  out?: Text2DEffectSample,
): Text2DEffectSample {
  if (context.paused && context.last) return context.last;
  const fontSize = context.fontSize > 0 ? context.fontSize : 0.32;
  let x = 0;
  let y = 0;
  if (effects.shake) {
    // Smooth between fixed noise samples so motion is independent of frame rate.
    const time = context.time * SHAKE_SPEED;
    const amplitude = effects.shake * fontSize * SHAKE_SCALE;
    x += shakeNoise(time, context.index * 2 + 1) * amplitude;
    y += shakeNoise(time, context.index * 2 + 2) * amplitude;
  }
  if (effects.waveSpeed || effects.waveIntensity) {
    y +=
      Math.sin(context.time * (effects.waveSpeed || 1) + context.index) *
      (effects.waveIntensity || 1) *
      fontSize;
  }
  if (effects.hover) {
    y += Math.sin(context.time * HOVER_SPEED + context.hoverPhase) * effects.hover * fontSize;
  }
  const rotation =
    effects.rotate !== 0
      ? Math.sin(context.time * ROTATE_SPEED + context.rotatePhase) *
        ((effects.rotate * Math.PI) / 180)
      : 0;
  if (!out) return { x, y, rotation };
  out.x = x;
  out.y = y;
  out.rotation = rotation;
  return out;
}

export function layoutHasLetterEffects(layout: Text2DLayout): boolean {
  return layout.items.some(
    (item) =>
      item.effects.shake !== 0 ||
      item.effects.waveSpeed !== 0 ||
      item.effects.waveIntensity !== 0 ||
      item.effects.hover !== 0 ||
      item.effects.rotate !== 0,
  );
}
