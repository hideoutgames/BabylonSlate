import {
  identitySerializedTransform,
  type SerializedComponent,
  type SerializedScene,
} from "./scene";
import {
  parseSceneLayerHitTest,
  type SceneLayerHitTest,
} from "./scene-layer";
import {
  DEFAULT_RICH_TEXT_EXAMPLE,
  richTextImageGuids,
  type Rgb,
} from "./rich-text";

export { DEFAULT_RICH_TEXT_EXAMPLE };

export const DEFAULT_TEXT2D_TEXT = "Text";
export const DEFAULT_TEXT2D_SIZE = 32;
export const DEFAULT_TEXT2D_WRAP_WIDTH = 200;
export const DEFAULT_TEXT2D_WRAP_HEIGHT = 64;
export const DEFAULT_TEXT2D_COLOR: Rgb = [1, 1, 1];
export const DEFAULT_TEXT2D_OUTLINE_COLOR: Rgb = [0, 0, 0];

export const TEXT2D_RENDERERS = ["bitmap", "msdf"] as const;
export type Text2DRenderer = (typeof TEXT2D_RENDERERS)[number];

export const TEXT2D_ALIGNMENTS = ["left", "center", "right"] as const;
export type Text2DAlignment = (typeof TEXT2D_ALIGNMENTS)[number];

export const TEXT2D_VERTICAL_ALIGNMENTS = ["top", "center", "bottom"] as const;
export type Text2DVerticalAlignment = (typeof TEXT2D_VERTICAL_ALIGNMENTS)[number];

export const TEXT2D_COMPONENT_CLASS_IDS = [
  "2DTextComponent",
  "2DRichTextComponent",
] as const;

export type Text2DProperties = {
  text: string;
  fontAssetGuid: string | null;
  size: number;
  color: Rgb;
  renderer: Text2DRenderer;
  outline: number;
  outlineColor: Rgb;
  alignment: Text2DAlignment;
  verticalAlignment: Text2DVerticalAlignment;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  hitTest: SceneLayerHitTest;
  wrapWidth: number;
  wrapHeight: number;
};

function parseRgb(value: unknown, fallback: Rgb): Rgb {
  if (!Array.isArray(value) || value.length < 3) return [...fallback] as Rgb;
  const r = value[0];
  const g = value[1];
  const b = value[2];
  if (
    typeof r !== "number" ||
    !Number.isFinite(r) ||
    typeof g !== "number" ||
    !Number.isFinite(g) ||
    typeof b !== "number" ||
    !Number.isFinite(b)
  ) {
    return [...fallback] as Rgb;
  }
  return [r, g, b];
}

export const TEXT2D_RENDERER_LABELS: Record<Text2DRenderer, string> = {
  bitmap: "Bitmap",
  msdf: "MSDF",
};

export const TEXT2D_ALIGNMENT_LABELS: Record<Text2DAlignment, string> = {
  left: "Left",
  center: "Center",
  right: "Right",
};

export const TEXT2D_VERTICAL_ALIGNMENT_LABELS: Record<
  Text2DVerticalAlignment,
  string
> = {
  top: "Top",
  center: "Center",
  bottom: "Bottom",
};

export type Text2DMsdfStatus =
  | "ready"
  | "no-font"
  | "none"
  | "json-only"
  | "png-only";

export function text2dMsdfStatus(
  fontAssetGuid: string | null,
  flags: { json?: boolean; png?: boolean } | undefined,
): Text2DMsdfStatus {
  if (!fontAssetGuid) return "no-font";
  const json = flags?.json === true;
  const png = flags?.png === true;
  if (json && png) return "ready";
  if (json) return "json-only";
  if (png) return "png-only";
  return "none";
}

export function text2dMsdfDescription(status: Text2DMsdfStatus): string {
  switch (status) {
    case "ready":
      return "MSDF stays crisp at any scale. This atlas is one weight/style.";
    case "no-font":
      return "Pick a Font that has an MSDF atlas (JSON + PNG).";
    case "json-only":
      return "This Font has MSDF JSON but no atlas PNG. Import the matching PNG.";
    case "png-only":
      return "This Font has an atlas PNG but no MSDF JSON. Import the matching JSON.";
    default:
      return "This Font has no MSDF atlas. Open it and use Import MSDF Atlas, or Import a JSON + PNG pair.";
  }
}

export function parseText2DRenderer(value: unknown): Text2DRenderer {
  return value === "msdf" ? "msdf" : "bitmap";
}

export function resolveText2DRenderer(
  renderer: unknown,
  hasMsdfPair: boolean,
): Text2DRenderer {
  return parseText2DRenderer(renderer) === "msdf" && hasMsdfPair
    ? "msdf"
    : "bitmap";
}

export function parseText2DAlignment(value: unknown): Text2DAlignment {
  return TEXT2D_ALIGNMENTS.includes(value as Text2DAlignment)
    ? (value as Text2DAlignment)
    : "left";
}

export function parseText2DVerticalAlignment(
  value: unknown,
): Text2DVerticalAlignment {
  return TEXT2D_VERTICAL_ALIGNMENTS.includes(value as Text2DVerticalAlignment)
    ? (value as Text2DVerticalAlignment)
    : "center";
}

export function parseText2DProperties(
  value: unknown,
  options: { rich?: boolean } = {},
): Text2DProperties {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const defaultText = options.rich ? DEFAULT_RICH_TEXT_EXAMPLE : DEFAULT_TEXT2D_TEXT;
  const size =
    typeof source.size === "number" && Number.isFinite(source.size) && source.size > 0
      ? source.size
      : DEFAULT_TEXT2D_SIZE;
  const outline =
    typeof source.outline === "number" &&
    Number.isFinite(source.outline) &&
    source.outline >= 0
      ? source.outline
      : 0;
  const wrapWidth =
    typeof source.wrapWidth === "number" &&
    Number.isFinite(source.wrapWidth) &&
    source.wrapWidth >= 0
      ? source.wrapWidth
      : 0;
  const wrapHeight =
    typeof source.wrapHeight === "number" &&
    Number.isFinite(source.wrapHeight) &&
    source.wrapHeight >= 0
      ? source.wrapHeight
      : 0;
  return {
    text: typeof source.text === "string" ? source.text : defaultText,
    fontAssetGuid:
      typeof source.fontAssetGuid === "string" && source.fontAssetGuid.trim()
        ? source.fontAssetGuid.trim()
        : null,
    size,
    color: parseRgb(source.color, DEFAULT_TEXT2D_COLOR),
    renderer: parseText2DRenderer(source.renderer),
    outline,
    outlineColor: parseRgb(source.outlineColor, DEFAULT_TEXT2D_OUTLINE_COLOR),
    alignment: parseText2DAlignment(source.alignment),
    verticalAlignment: parseText2DVerticalAlignment(source.verticalAlignment),
    bold: source.bold === true,
    italic: source.italic === true,
    underline: source.underline === true,
    hitTest: parseSceneLayerHitTest(source.hitTest, "ignore"),
    wrapWidth,
    wrapHeight,
  };
}

function componentProperties(rich: boolean): Record<string, unknown> {
  const parsed = parseText2DProperties({}, { rich });
  return {
    text: parsed.text,
    fontAssetGuid: parsed.fontAssetGuid,
    size: parsed.size,
    color: [...parsed.color],
    renderer: parsed.renderer,
    outline: parsed.outline,
    outlineColor: [...parsed.outlineColor],
    alignment: parsed.alignment,
    verticalAlignment: parsed.verticalAlignment,
    bold: parsed.bold,
    italic: parsed.italic,
    underline: parsed.underline,
    hitTest: parsed.hitTest,
    wrapWidth: DEFAULT_TEXT2D_WRAP_WIDTH,
    wrapHeight: DEFAULT_TEXT2D_WRAP_HEIGHT,
  };
}

export function createText2DComponent(id: string): SerializedComponent {
  return {
    id,
    classId: "2DTextComponent",
    properties: componentProperties(false),
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

export function createRichText2DComponent(id: string): SerializedComponent {
  return {
    id,
    classId: "2DRichTextComponent",
    properties: componentProperties(true),
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

function isText2DClass(classId: string): boolean {
  return (TEXT2D_COMPONENT_CLASS_IDS as readonly string[]).includes(classId);
}

export function text2dFontGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (!isText2DClass(component.classId)) continue;
      const guid = parseText2DProperties(component.properties).fontAssetGuid;
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      found.push(guid);
    }
  }
  return found;
}

export function text2dImageGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (component.classId !== "2DRichTextComponent") continue;
      const text = parseText2DProperties(component.properties, { rich: true }).text;
      for (const guid of richTextImageGuids(text)) {
        if (seen.has(guid)) continue;
        seen.add(guid);
        found.push(guid);
      }
    }
  }
  return found;
}
