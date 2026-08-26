export type Rgb = [number, number, number];

export type ParseRichTextDefaults = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: Rgb;
  size: number;
  outline: number;
  outlineColor: Rgb;
};

export type RichTextStyle = ParseRichTextDefaults;

export type RichTextEffects = {
  shake: number;
  waveSpeed: number;
  waveIntensity: number;
  hover: number;
  rotate: number;
};

export type RichTextSpan =
  | {
      kind: "text";
      text: string;
      style: RichTextStyle;
      effects: RichTextEffects;
    }
  | {
      kind: "image";
      guid: string;
      size: number;
      style: RichTextStyle;
      effects: RichTextEffects;
    };

export const DEFAULT_RICH_TEXT_EXAMPLE =
  "[color=green]Hello [b]this [img=PASTE_TEXTURE_GUID size=14] image[/b] has a [rotate=45]custom [b][shake=1]size[/shake][/rotate] and this one does [/color][color=FFFF]not[/color]";

const NAMED_COLORS: Record<string, Rgb> = {
  aqua: [0, 1, 1],
  black: [0, 0, 0],
  blue: [0, 0, 1],
  fuchsia: [1, 0, 1],
  gray: [128 / 255, 128 / 255, 128 / 255],
  grey: [128 / 255, 128 / 255, 128 / 255],
  green: [0, 128 / 255, 0],
  lime: [0, 1, 0],
  maroon: [128 / 255, 0, 0],
  navy: [0, 0, 128 / 255],
  olive: [128 / 255, 128 / 255, 0],
  orange: [1, 165 / 255, 0],
  purple: [128 / 255, 0, 128 / 255],
  red: [1, 0, 0],
  silver: [192 / 255, 192 / 255, 192 / 255],
  teal: [0, 128 / 255, 128 / 255],
  white: [1, 1, 1],
  yellow: [1, 1, 0],
};

const WRAPPER_TAGS = new Set([
  "b",
  "i",
  "u",
  "color",
  "size",
  "outline",
  "outline-color",
  "shake",
  "wave",
  "hover",
  "rotate",
]);
const VOID_TAGS = new Set(["img"]);

type Frame = RichTextStyle & RichTextEffects;

type OpenTag = { name: string; frame: Frame };

type ParsedTag = {
  closing: boolean;
  name: string;
  primary: string | null;
  attrs: Record<string, string>;
};

function hexNibble(ch: string): number | null {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  const upper = ch.toUpperCase().charCodeAt(0);
  if (upper >= 65 && upper <= 70) return upper - 55;
  return null;
}

function parseHexChannel(hex: string, start: number, count: number): number | null {
  if (count === 1) {
    const n = hexNibble(hex[start] ?? "");
    return n === null ? null : n / 15;
  }
  const hi = hexNibble(hex[start] ?? "");
  const lo = hexNibble(hex[start + 1] ?? "");
  if (hi === null || lo === null) return null;
  return (hi * 16 + lo) / 255;
}

export function parseRichTextColor(value: string): Rgb | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return [...named] as Rgb;
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const r = parseHexChannel(hex, 0, 1);
    const g = parseHexChannel(hex, 1, 1);
    const b = parseHexChannel(hex, 2, 1);
    if (r === null || g === null || b === null) return null;
    return [r, g, b];
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseHexChannel(hex, 0, 2);
    const g = parseHexChannel(hex, 2, 2);
    const b = parseHexChannel(hex, 4, 2);
    if (r === null || g === null || b === null) return null;
    return [r, g, b];
  }
  return null;
}

function parseTagInner(inner: string): ParsedTag | null {
  const closing = inner.startsWith("/");
  const body = closing ? inner.slice(1) : inner;
  const match = /^([a-zA-Z][a-zA-Z0-9-]*)(.*)$/.exec(body);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  let primary: string | null = null;
  const attrs: Record<string, string> = {};
  if (rest.startsWith("=")) {
    const after = rest.slice(1);
    const space = after.search(/\s/);
    if (space < 0) {
      primary = after;
    } else {
      primary = after.slice(0, space);
      Object.assign(attrs, parseAttrs(after.slice(space + 1)));
    }
  } else if (rest.length > 0) {
    Object.assign(attrs, parseAttrs(rest));
  }
  return { closing, name, primary: primary || null, attrs };
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const parts = source.trim().split(/\s+/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    attrs[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return attrs;
}

function isKnownTag(name: string): boolean {
  return WRAPPER_TAGS.has(name) || VOID_TAGS.has(name);
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

function styleOf(frame: Frame): RichTextStyle {
  return {
    bold: frame.bold,
    italic: frame.italic,
    underline: frame.underline,
    color: [...frame.color] as Rgb,
    size: frame.size,
    outline: frame.outline,
    outlineColor: [...frame.outlineColor] as Rgb,
  };
}

function effectsOf(frame: Frame): RichTextEffects {
  return {
    shake: frame.shake,
    waveSpeed: frame.waveSpeed,
    waveIntensity: frame.waveIntensity,
    hover: frame.hover,
    rotate: frame.rotate,
  };
}

function sameRun(a: RichTextSpan, b: RichTextSpan): boolean {
  if (a.kind !== "text" || b.kind !== "text") return false;
  return (
    JSON.stringify(a.style) === JSON.stringify(b.style) &&
    JSON.stringify(a.effects) === JSON.stringify(b.effects)
  );
}

function applyTag(frame: Frame, tag: ParsedTag): Frame {
  const next: Frame = {
    ...frame,
    color: [...frame.color] as Rgb,
    outlineColor: [...frame.outlineColor] as Rgb,
  };
  const primary = tag.primary;
  switch (tag.name) {
    case "b":
      next.bold = true;
      break;
    case "i":
      next.italic = true;
      break;
    case "u":
      next.underline = true;
      break;
    case "color": {
      const parsed = primary ? parseRichTextColor(primary) : null;
      if (parsed) next.color = parsed;
      break;
    }
    case "size": {
      const size = Number(primary);
      if (Number.isFinite(size) && size > 0) next.size = size;
      break;
    }
    case "outline": {
      if (primary === null) next.outline = next.outline > 0 ? next.outline : 1;
      else {
        const width = Number(primary);
        if (Number.isFinite(width) && width >= 0) next.outline = width;
      }
      break;
    }
    case "outline-color": {
      const parsed = primary ? parseRichTextColor(primary) : null;
      if (parsed) next.outlineColor = parsed;
      break;
    }
    case "shake": {
      const intensity = Number(primary ?? "1");
      next.shake = Number.isFinite(intensity) ? intensity : 1;
      break;
    }
    case "wave": {
      const speed = Number(primary ?? "1");
      next.waveSpeed = Number.isFinite(speed) ? speed : 1;
      const intensityRaw = tag.attrs.intensity;
      if (intensityRaw !== undefined) {
        const intensity = Number(intensityRaw);
        next.waveIntensity = Number.isFinite(intensity) ? intensity : 1;
      } else {
        next.waveIntensity = 1;
      }
      break;
    }
    case "hover": {
      const intensity = Number(primary ?? "1");
      next.hover = Number.isFinite(intensity) ? intensity : 1;
      break;
    }
    case "rotate": {
      const degrees = Number(primary ?? "0");
      next.rotate = Number.isFinite(degrees) ? degrees : 0;
      break;
    }
    default:
      break;
  }
  return next;
}

function pushText(spans: RichTextSpan[], text: string, frame: Frame): void {
  if (!text) return;
  const span: RichTextSpan = {
    kind: "text",
    text,
    style: styleOf(frame),
    effects: effectsOf(frame),
  };
  const last = spans[spans.length - 1];
  if (last && sameRun(last, span) && last.kind === "text") {
    last.text += text;
    return;
  }
  spans.push(span);
}

export function parseRichText(
  source: string,
  defaults: ParseRichTextDefaults,
): RichTextSpan[] {
  const root: Frame = { ...defaults, ...emptyEffects() };
  const stack: OpenTag[] = [{ name: "", frame: root }];
  const spans: RichTextSpan[] = [];
  const current = (): Frame => stack[stack.length - 1]!.frame;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("[", index);
    if (open < 0) {
      pushText(spans, source.slice(index), current());
      break;
    }
    if (open > index) pushText(spans, source.slice(index, open), current());
    const close = source.indexOf("]", open + 1);
    if (close < 0) {
      pushText(spans, source.slice(open), current());
      break;
    }
    const inner = source.slice(open + 1, close);
    const tag = parseTagInner(inner);
    if (!tag || !isKnownTag(tag.name)) {
      pushText(spans, source.slice(open, close + 1), current());
      index = close + 1;
      continue;
    }
    if (tag.closing) {
      if (WRAPPER_TAGS.has(tag.name)) {
        for (let i = stack.length - 1; i >= 1; i -= 1) {
          if (stack[i]!.name === tag.name) {
            stack.length = i;
            break;
          }
        }
      }
      index = close + 1;
      continue;
    }
    if (VOID_TAGS.has(tag.name)) {
      const guid = (tag.primary ?? "").trim();
      if (guid) {
        const sizeRaw = tag.attrs.size;
        const sizeNum = sizeRaw !== undefined ? Number(sizeRaw) : current().size;
        spans.push({
          kind: "image",
          guid,
          size: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : current().size,
          style: styleOf(current()),
          effects: effectsOf(current()),
        });
      }
      index = close + 1;
      continue;
    }
    stack.push({ name: tag.name, frame: applyTag(current(), tag) });
    index = close + 1;
  }
  return spans;
}

export function richTextImageGuids(source: string): string[] {
  const spans = parseRichText(source, {
    bold: false,
    italic: false,
    underline: false,
    color: [1, 1, 1],
    size: 32,
    outline: 0,
    outlineColor: [0, 0, 0],
  });
  const found: string[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    if (span.kind !== "image" || seen.has(span.guid)) continue;
    seen.add(span.guid);
    found.push(span.guid);
  }
  return found;
}
