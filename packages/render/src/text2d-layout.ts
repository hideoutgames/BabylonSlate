import {
  parseRichText,
  parseText2DProperties,
  type RichTextEffects,
  type RichTextSpan,
  type RichTextStyle,
  type Text2DAlignment,
  type Text2DProperties,
} from "@babylonslate/core";

export type GlyphSource = "bitmap" | "msdf";

export type GlyphMetrics = {
  width: number;
  height: number;
  bearingX: number;
  bearingY: number;
  advance: number;
  source: GlyphSource;
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
  wrapWidth: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  outline: number;
  outlineColor: [number, number, number];
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
  uvs?: GlyphMetrics["uvs"];
  index: number;
};

const HOVER_SPEED = 2;
const ROTATE_SPEED = 2;
const SHAKE_SCALE = 0.08;

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

function spansFrom(input: LayoutText2DInput): RichTextSpan[] {
  const defaults: RichTextStyle = {
    bold: input.bold,
    italic: input.italic,
    underline: input.underline,
    color: [...input.color] as [number, number, number],
    size: input.size,
    outline: input.outline,
    outlineColor: [...input.outlineColor] as [number, number, number],
  };
  if (input.rich) return parseRichText(input.text, defaults);
  return [
    {
      kind: "text",
      text: input.text,
      style: defaults,
      effects: emptyEffects(),
    },
  ];
}

function flushLine(
  line: Pending[],
  cursorY: number,
  alignment: Text2DAlignment,
  items: Text2DLayoutItem[],
): { width: number; height: number } {
  if (line.length === 0) {
    return { width: 0, height: 0 };
  }
  const lineWidth = line.reduce((sum, entry) => sum + entry.advance, 0);
  const lineHeight = Math.max(...line.map((entry) => entry.height), 0);
  const shift =
    alignment === "center" ? -lineWidth / 2 : alignment === "right" ? -lineWidth : 0;
  let cursorX = shift;
  for (const entry of line) {
    const x = cursorX + entry.bearingX + entry.width / 2;
    const y = cursorY + entry.bearingY;
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
    if (entry.style.underline) {
      items.push({
        kind: "underline",
        x,
        y: y - entry.height / 2,
        width: entry.width,
        height: Math.max(entry.height * 0.06, 0.004),
        style: entry.style,
        effects: entry.effects,
        source: "bitmap",
        index: entry.index,
        hoverPhase: hoverPhaseFor(entry.index),
        rotatePhase: rotatePhaseFor(entry.index),
      });
    }
    cursorX += entry.advance;
  }
  return { width: lineWidth, height: lineHeight };
}

/** Layout glyph/image quads in world units (pixels / pixelsPerUnit). */
export function layoutText2D(input: LayoutText2DInput): Text2DLayout {
  const ppu = input.pixelsPerUnit > 0 ? input.pixelsPerUnit : 100;
  const wrapWorld = input.wrapWidth > 0 ? input.wrapWidth / ppu : 0;
  const items: Text2DLayoutItem[] = [];
  const lines: Array<{ pending: Pending[]; width: number; height: number }> = [];
  let line: Pending[] = [];
  let lineAdvance = 0;
  let glyphIndex = 0;
  const defaultLineHeight = input.size / ppu;

  const breakLine = () => {
    const flushed = flushLine(line, 0, input.alignment, []);
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

  for (const span of spansFrom(input)) {
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
        index: glyphIndex,
      });
      glyphIndex += 1;
      continue;
    }
    for (const ch of span.text) {
      if (ch === "\n") {
        breakLine();
        continue;
      }
      const metrics = input.metrics.measureGlyph(ch, span.style);
      pushPending({
        kind: "glyph",
        ch,
        width: metrics.width,
        height: metrics.height,
        advance: metrics.advance,
        bearingX: metrics.bearingX,
        bearingY: metrics.bearingY,
        style: span.style,
        effects: span.effects,
        source: metrics.source,
        uvs: metrics.uvs,
        index: glyphIndex,
      });
      glyphIndex += 1;
    }
  }
  if (line.length > 0 || lines.length === 0) breakLine();

  const totalHeight = lines.reduce((sum, entry) => sum + entry.height, 0);
  const totalWidth = Math.max(0, ...lines.map((entry) => entry.width));
  let cursorY = totalHeight / 2;
  for (const row of lines) {
    cursorY -= row.height / 2;
    flushLine(row.pending, cursorY, input.alignment, items);
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
      wrapWidth: parsed.wrapWidth,
      bold: parsed.bold,
      italic: parsed.italic,
      underline: parsed.underline,
      outline: parsed.outline,
      outlineColor: parsed.outlineColor,
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
  noise?: () => number;
  paused?: boolean;
  last?: Text2DEffectSample;
};

/** Stack shake / wave / hover / rotate in world units. */
export function combineText2DEffects(
  effects: RichTextEffects,
  context: Text2DEffectContext,
): Text2DEffectSample {
  if (context.paused && context.last) return context.last;
  const fontSize = context.fontSize > 0 ? context.fontSize : 0.32;
  const noise = context.noise ?? Math.random;
  let x = 0;
  let y = 0;
  if (effects.shake) {
    x += (noise() * 2 - 1) * effects.shake * fontSize * SHAKE_SCALE;
    y += (noise() * 2 - 1) * effects.shake * fontSize * SHAKE_SCALE;
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
  return { x, y, rotation };
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
