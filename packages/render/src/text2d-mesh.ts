import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { CreatePlaneVertexData } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";
import {
  parseSceneLayerHitTest,
  parseText2DProperties,
  resolveText2DRenderer,
  text2DCharacterReveal,
  type RichTextStyle,
  type SceneLayerHitTest,
  type Text2DProperties,
  type Text2DRenderer,
} from "@haptic/core";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import {
  bitmapGlyphKey,
  DEFAULT_BITMAP_WORKING_BYTES,
  measureBitmapGlyph,
  planBitmapGlyphAtlas,
  measurePixelGlyph,
  pixelGlyphKey,
  pixelScaleOf,
  rasterizeBitmapGlyph,
  rasterizePixelGlyph,
  resolveText2DFont,
  type BitmapAllocationLimits,
  type BitmapCanvasScratch,
  type BitmapGlyphCell,
} from "./text2d-bitmap";
import { VisualBundle } from "./visual-bundle";
import { materialRestore, setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";
import { bindTextMaterialGlyph } from "./text-material-block";
import { glyphBatchVertexData, writeGlyphBatchPositions, type GlyphBatchQuad } from "./text2d-glyph-batch";
import { sceneGlyphAtlas, type AtlasGlyph, type GlyphAtlasPage } from "./text2d-glyph-atlas";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import {
  combineText2DEffects,
  layoutText2DFromProperties,
  type GlyphMetricsProvider,
  type Text2DEffectContext,
  type Text2DLayoutItem,
  type Text2DLayout,
} from "./text2d-layout";

export type Text2DMeshOptions = {
  rich?: boolean;
  metrics?: GlyphMetricsProvider;
  isPaused?: () => boolean;
  bitmapLimits?: Partial<BitmapAllocationLimits>;
};

export type Text2DAssetContext = MeshAssetContext & {
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  fontMsdfPng?: ReadonlyMap<string, Uint8Array | Blob>;
  paused?: boolean;
};

const textMaterialVisuals = new WeakMap<Mesh, { guid: string | null; glyphs: Array<{ mesh: Mesh; restore: () => void }> }>();
const appearVisuals = new WeakMap<Mesh, (progress: number) => void>();
const textLayouts = new WeakMap<Mesh, Text2DLayout>();

/** One batch mesh of a text: the glyphs that share `key` (`glyphBatchKey`), as the quads it last drew. */
type GlyphBatch = { key: string; mesh: Mesh; quads: GlyphBatchQuad[] };

/**
 * What a built text owns and was built for, by its root: what `updateText2DMesh` must find unchanged to redraw the
 * text with the meshes, materials and atlas texture it has.
 */
type Text2DBuild = {
  name: string;
  rich: boolean;
  materialGuid: string | null;
  renderer: Text2DRenderer;
  fontGuid: string | null;
  fontStack: string;
  /** The font's Pixel Size while it draws as a pixel font, else 0. */
  pixelSize: number;
  hitTest: SceneLayerHitTest;
  /** `release` lets go of the atlas glyphs the text holds now. */
  held: { release: () => void };
  /** In creation order, which is the order of each batch's first glyph. */
  batches: GlyphBatch[];
  /** Glyphs, images and underlines drawn as a plane each. */
  planes: number;
  wrapW: number;
  wrapH: number;
};
const text2DBuilds = new WeakMap<Mesh, Text2DBuild>();

/** Measured glyph layout retained for native SceneLayer text editing feedback. */
export function text2DMeshLayout(mesh: Mesh): Text2DLayout | undefined { return textLayouts.get(mesh); }

/** Apply a simulation-owned reveal sample without rebuilding glyphs or atlases. */
export function updateText2DAppear(mesh: Mesh, progress: number): void {
  if (!mesh.isDisposed() && Number.isFinite(progress)) {
    appearVisuals.get(mesh)?.(Math.min(1, Math.max(0, progress)));
  }
}

/** Rebind hot-reloaded Text graphs without replacing the atlas or layout. */
export function refreshText2DMaterials(root: Mesh, assets?: MeshAssetContext): void {
  for (const visual of [root, ...root.getChildMeshes()]) {
    if (!(visual instanceof Mesh)) continue;
    const entry = textMaterialVisuals.get(visual);
    if (!entry) continue;
    const material = entry.guid ? assets?.resolveMaterial?.(entry.guid, { scene: visual.getScene(), unlit: true }) : null;
    const accepted = material?.metadata?.materialDomain === "text" ? material : null;
    for (const glyph of entry.glyphs) {
      if (accepted) glyph.mesh.material = accepted;
      else glyph.restore();
    }
  }
}

/** CPU restoration data plus native bitmap storage kept during replacement. */
export function text2DBitmapBytes(root: Mesh | undefined): number {
  if (!root) return 0;
  return [root, ...root.getChildMeshes()].reduce((total, mesh) => {
    const bytes = (mesh.metadata as { text2dBitmapBytes?: number } | null)?.text2dBitmapBytes ?? 0;
    return total + bytes;
  }, 0);
}

type MsdfGlyph = {
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
};

export type MsdfAtlas = {
  size: number;
  scaleW: number;
  scaleH: number;
  chars: Map<number, MsdfGlyph>;
};

const MSDF_ITALIC_SHEAR = -0.2;
const loggedMsdfFallback = new Set<string>();

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Parse an msdf-bmfont JSON atlas. */
function parseMsdfAtlas(bytes: Uint8Array): MsdfAtlas | null {
  const parsed = decodeJson(bytes) as {
    info?: { size?: number };
    common?: { scaleW?: number; scaleH?: number };
    chars?: Array<Record<string, unknown>>;
  } | null;
  if (!parsed || !Array.isArray(parsed.chars)) return null;
  const chars = new Map<number, MsdfGlyph>();
  for (const entry of parsed.chars) {
    const id = Number(entry.id);
    if (!Number.isFinite(id)) continue;
    chars.set(id, {
      x: Number(entry.x) || 0,
      y: Number(entry.y) || 0,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      xoffset: Number(entry.xoffset) || 0,
      yoffset: Number(entry.yoffset) || 0,
      xadvance: Number(entry.xadvance) || 0,
    });
  }
  return {
    size: parsed.info?.size && parsed.info.size > 0 ? parsed.info.size : 32,
    scaleW: parsed.common?.scaleW && parsed.common.scaleW > 0 ? parsed.common.scaleW : 1,
    scaleH: parsed.common?.scaleH && parsed.common.scaleH > 0 ? parsed.common.scaleH : 1,
    chars,
  };
}

/** Quad size follows the raster cell so 5×7 fallback is not stretched to measureText. */
function bitmapMetrics(
  pixelsPerUnit: number,
  measure: (ch: string, style: RichTextStyle) => Pick<BitmapGlyphCell, "width" | "height" | "inkBounds">,
): GlyphMetricsProvider {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  return {
    measureGlyph(ch, style) {
      if (!ch.trim()) {
        const world = style.size / ppu;
        return {
          width: world * 0.4,
          height: world,
          bearingX: 0,
          bearingY: 0,
          advance: world * 0.4,
          source: "bitmap",
        };
      }
      const cell = measure(ch, style);
      const worldW = cell.width / ppu;
      const worldH = cell.height / ppu;
      return {
        width: worldW,
        height: worldH,
        bearingX: 0,
        bearingY: 0,
        advance: worldW,
        source: "bitmap",
        inkBounds: cell.inkBounds && {
          top: cell.inkBounds.top / ppu,
          bottom: cell.inkBounds.bottom / ppu,
        },
      };
    },
    measureImage(_guid, sizePx) {
      const height = sizePx / ppu;
      return { width: height, height };
    },
  };
}

/**
 * A pixel font's metrics: each glyph's native cell times its whole-number scale, advancing by the font's own
 * advance, with the pen at the cell's origin column. Whitespace advances by its own width and draws nothing.
 * `native` is null without a 2D canvas, which then falls back to `fallback` cells.
 */
function pixelMetrics(
  pixelsPerUnit: number,
  pixelSize: number,
  native: (ch: string, style: RichTextStyle) => { width: number; height: number; originX: number; advance: number; inkBounds?: BitmapGlyphCell["inkBounds"] } | null,
  fallback: (ch: string, style: RichTextStyle) => Pick<BitmapGlyphCell, "width" | "height" | "inkBounds">,
): GlyphMetricsProvider {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  const plain = bitmapMetrics(ppu, fallback);
  return {
    measureGlyph(ch, style) {
      const cell = native(ch, style);
      if (!cell) return plain.measureGlyph(ch, style);
      const unit = pixelScaleOf(style, pixelSize) / ppu;
      return {
        width: cell.width * unit,
        height: cell.height * unit,
        bearingX: -cell.originX * unit,
        bearingY: 0,
        advance: cell.advance * unit,
        source: "bitmap",
        inkBounds: cell.inkBounds && { top: cell.inkBounds.top * unit, bottom: cell.inkBounds.bottom * unit },
      };
    },
    measureImage: plain.measureImage,
  };
}

/** Moves every quad so its edges fall on whole pixels; a line's quads share their offset, so spacing is kept. */
function snapLayoutToPixels(layout: Text2DLayout, pixelsPerUnit: number): Text2DLayout {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  const snap = (edge: number) => Math.round(edge * ppu) / ppu;
  return {
    ...layout,
    items: layout.items.map((item) => ({
      ...item,
      x: snap(item.x - item.width / 2) + item.width / 2,
      y: snap(item.y - item.height / 2) + item.height / 2,
    })),
  };
}

function msdfMetrics(
  atlas: MsdfAtlas,
  pixelsPerUnit: number,
  fallback: GlyphMetricsProvider,
): GlyphMetricsProvider {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  return {
    measureGlyph(ch, style) {
      const glyph = atlas.chars.get(ch.codePointAt(0) ?? -1);
      if (!glyph || glyph.width <= 0) return fallback.measureGlyph(ch, style);
      const scale = style.size / atlas.size / ppu;
      return {
        width: glyph.width * scale,
        height: glyph.height * scale,
        bearingX: glyph.xoffset * scale,
        bearingY: -glyph.yoffset * scale,
        advance: glyph.xadvance * scale,
        source: "msdf",
        uvs: {
          u0: glyph.x / atlas.scaleW,
          v0: 1 - (glyph.y + glyph.height) / atlas.scaleH,
          u1: (glyph.x + glyph.width) / atlas.scaleW,
          v1: 1 - glyph.y / atlas.scaleH,
        },
      };
    },
    measureImage: fallback.measureImage.bind(fallback),
  };
}

/** Text glyphs draw from both sides, fogged with the world. */
const TEXT_GLYPH: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: true, role: "world" };
const TEXT_SOLID: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "world" };
/**
 * MSDF glyphs keep the look of the shader they replaced: exact display colours (a tilemap atlas's image processing,
 * still decoded for a Scene Linear stage), no fog, blended by their coverage.
 */
const TEXT_MSDF: UnlitMaterialKey = { textured: true, msdf: true, backFaceCulling: false, fog: false, role: "world", imageProcessing: "atlas" };

/** An MSDF glyph style: its fill and outline over the atlas's distance field; coverage below 0.01 is discarded. */
function msdfGlyphBinding(atlas: BaseTexture, style: RichTextStyle): UnlitBinding {
  return {
    texture: atlas, color: [style.color[0], style.color[1], style.color[2]], alpha: 1, cutoff: 0.01, blend: true, textureAlpha: false,
    twoSided: false, msdf: { strokeColor: [style.outlineColor[0], style.outlineColor[1], style.outlineColor[2]], strokeWidth: Math.max(0, style.outline) * 0.08 },
  };
}

/** A bitmap glyph: its atlas's colour and coverage, cut out at 0.4 unless the text fades in. */
function bitmapGlyphBinding(atlas: Texture, fade: boolean): UnlitBinding {
  atlas.hasAlpha = true;
  return { texture: atlas, color: [1, 1, 1], alpha: 1, cutoff: fade ? 0 : 0.4, blend: fade, textureAlpha: true, twoSided: false };
}

/** A solid glyph, underline or image placeholder: its colour (display space), blended while the text fades in. */
function solidGlyphBinding(color: readonly [number, number, number], fade: boolean): UnlitBinding {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    texture: null, color: [clamp(color[0]), clamp(color[1]), clamp(color[2])], alpha: 1, cutoff: 0, blend: fade, textureAlpha: false, twoSided: false,
  };
}

function msdfAtlasTexture(
  scene: Scene,
  fontGuid: string,
  png: Uint8Array | Blob,
  assets?: Text2DAssetContext,
): import("./resource-cache").ResourceLease<BaseTexture> | null {
  if (!assets?.resourceCache) return null;
  return assets.resourceCache.acquireTexture(
    `font-msdf-png:${fontGuid}`,
    scene.getEngine(),
    png,
    {
      noMipmap: true,
      samplingMode: Texture.BILINEAR_SAMPLINGMODE,
      invertY: false,
    },
  );
}

function applyGlyphUvs(
  mesh: Mesh,
  uvs: { u0: number; v0: number; u1: number; v1: number } | undefined,
): void {
  if (!uvs) return;
  mesh.setVerticesData(VertexBuffer.UVKind, [
    uvs.u0,
    uvs.v0,
    uvs.u1,
    uvs.v0,
    uvs.u1,
    uvs.v1,
    uvs.u0,
    uvs.v1,
  ]);
}

function warnMsdfFallback(fontGuid: string | null): void {
  const key = fontGuid ?? "";
  if (loggedMsdfFallback.has(key)) return;
  loggedMsdfFallback.add(key);
  console.warn("[render] 2D text MSDF atlas missing; using Bitmap");
}

function hasLetterEffects(item: Text2DLayoutItem): boolean {
  const fx = item.effects;
  return (
    fx.shake !== 0 ||
    fx.waveSpeed !== 0 ||
    fx.waveIntensity !== 0 ||
    fx.hover !== 0 ||
    fx.rotate !== 0
  );
}

function attachEffects(
  scene: Scene,
  parent: Mesh,
  glyphs: Array<{ mesh: Mesh; item: Text2DLayoutItem; restRotation: number }>,
  batches: readonly Mesh[],
  bundle: VisualBundle,
  properties: Text2DProperties,
  characterCount: number,
  pixelsPerUnit: number,
  isPaused?: () => boolean,
): void {
  let progress: number | undefined;
  const modes = properties.appearModes;
  const fade = modes.includes("fade");
  const scale = modes.includes("scale");
  const slide = modes.includes("slide");
  const entries = glyphs.map((entry) => ({
    ...entry,
    restScale: entry.mesh.scaling.clone(),
    sample: { x: 0, y: 0, rotation: 0 },
    sampled: false,
    slideOffset: 0,
  }));
  const effectEntries = entries.filter((entry) => hasLetterEffects(entry.item));
  const applyPose = (entry: (typeof entries)[number]) => {
    const { mesh, item, restRotation, sample, slideOffset } = entry;
    const x = item.x + sample.x;
    const y = item.y + sample.y - slideOffset;
    const rotation = restRotation + sample.rotation;
    // Babylon marks transforms dirty even when a setter receives the same value.
    if (mesh.position.x !== x) mesh.position.x = x;
    if (mesh.position.y !== y) mesh.position.y = y;
    if (mesh.rotation.z !== rotation) mesh.rotation.z = rotation;
  };
  const applyReveal = (value: number) => {
    if (progress === value) return;
    progress = value;
    for (const entry of entries) {
      const { mesh, item } = entry;
      const reveal = text2DCharacterReveal(value, item.index, characterCount, properties);
      const visibility = fade ? Math.max(0, Math.min(1, reveal)) : reveal !== 0 ? 1 : 0;
      if (mesh.visibility !== visibility) mesh.visibility = visibility;
      const amount = scale ? Math.max(0, reveal) : 1;
      const scaleX = entry.restScale.x * amount;
      const scaleY = entry.restScale.y * amount;
      if (mesh.scaling.x !== scaleX) mesh.scaling.x = scaleX;
      if (mesh.scaling.y !== scaleY) mesh.scaling.y = scaleY;
      entry.slideOffset = slide ? (1 - reveal) * item.style.size / pixelsPerUnit : 0;
      applyPose(entry);
    }
    // Batches exist only while no reveal mode is set, and then every character
    // is hidden until the whole timeline completes, so they share one sample.
    if (batches.length > 0) {
      const visibility = text2DCharacterReveal(value, 0, characterCount, properties) !== 0 ? 1 : 0;
      for (const batch of batches) if (batch.visibility !== visibility) batch.visibility = visibility;
    }
  };
  // Continuous effects visit only tagged glyphs and reuse their last reveal pose.
  const context: Text2DEffectContext = { time: 0, index: 0, fontSize: 0, hoverPhase: 0, rotatePhase: 0 };
  const tickEffects = (time: number) => {
    const paused = isPaused?.() === true;
    context.time = time;
    for (const entry of effectEntries) {
      const { item, sample } = entry;
      // A paused glyph holds its last sample once it has one.
      if (!paused || !entry.sampled) {
        context.index = item.index;
        context.fontSize = item.height;
        context.hoverPhase = item.hoverPhase;
        context.rotatePhase = item.rotatePhase;
        combineText2DEffects(item.effects, context, sample);
        entry.sampled = true;
      }
      applyPose(entry);
    }
  };
  let elapsed = 0;
  appearVisuals.set(parent, applyReveal);
  tickEffects(0);
  applyReveal(properties.appearProgress ?? (properties.appearStart === "revealed" ? 1 : 0));
  const observer: Nullable<Observer<Scene>> = effectEntries.length > 0 ? scene.onBeforeRenderObservable.add(() => {
    if (isPaused?.()) return;
    elapsed += scene.getEngine().getDeltaTime() / 1000;
    tickEffects(elapsed);
  }) : null;
  bundle.cancelWith(() => {
    appearVisuals.delete(parent);
    if (observer) scene.onBeforeRenderObservable.remove(observer);
  });
  parent.metadata = {
    ...(parent.metadata ?? {}),
    tickText2DEffects: (time: number) => { elapsed = time; tickEffects(time); },
  };
}

/** What a text is drawn with and how its glyphs lie: known once it is measured, before any glyph is rasterized. */
type Text2DSetup = {
  parsed: Text2DProperties;
  rich: boolean;
  fade: boolean;
  hitTest: SceneLayerHitTest;
  ppu: number;
  fontGuid: string | null;
  png: Uint8Array | Blob | undefined;
  fontStack: string;
  /** Whether the font draws its own bitmap glyphs at `pixelSize`. */
  pixel: boolean;
  pixelSize: number;
  renderer: Text2DRenderer;
  /** A glyph's atlas key: a pixel font's native cell, else the canvas cell at its size. */
  glyphKey: (ch: string, style: RichTextStyle) => string;
  layout: Text2DLayout;
  /** Whether any of its glyphs draws from a bitmap cell. */
  bitmap: boolean;
};

/** A measured text. `finish` rasterizes its bitmap glyphs, the costly part, which a caller that turns the draft down skips. */
type Text2DDraft = Text2DSetup & { finish(): Text2DPlan };

/**
 * What a text build measures and rasterizes before it creates or changes anything in the Scene. It holds its bitmap
 * glyphs in the Scene's atlas (`glyphs`, by `glyphKey`) until `release`: whoever takes a plan draws with it and
 * releases it when the text goes, or releases it at once.
 */
type Text2DPlan = Text2DSetup & {
  glyphs: ReadonlyMap<string, AtlasGlyph>;
  /** The texels its glyphs hold, as bytes on the CPU and the GPU. */
  bitmapBytes: number;
  release: () => void;
  wrapW: number;
  wrapH: number;
};

const parsedMsdfAtlases = new WeakMap<Uint8Array, MsdfAtlas | null>();

/** An installed font's parsed atlas: a text reads it at every build, and a script may rewrite a text every tick. */
function msdfAtlasOf(json: Uint8Array): MsdfAtlas | null {
  let atlas = parsedMsdfAtlases.get(json);
  if (atlas === undefined) {
    atlas = parseMsdfAtlas(json);
    parsedMsdfAtlases.set(json, atlas);
  }
  return atlas;
}

/**
 * Measures the text, lays it out and checks its bitmap glyphs against the allocation limits, as an atlas of its own
 * would need them; `finish` then rasterizes them and takes their places in the Scene's atlas.
 */
function draftText2D(
  scene: Scene,
  properties: unknown,
  assets: Text2DAssetContext | undefined,
  options: Text2DMeshOptions,
): Text2DDraft {
  const rich = options.rich === true;
  const parsed = parseText2DProperties(properties, { rich });
  const fade = rich && parsed.appearModes.includes("fade");
  const hitTest = parseSceneLayerHitTest(parsed.hitTest, "ignore");
  const ppu = assets?.pixelsPerUnit && assets.pixelsPerUnit > 0 ? assets.pixelsPerUnit : 100;
  const fontGuid = parsed.fontAssetGuid;
  const json = fontGuid ? assets?.fontMsdfJson?.get(fontGuid) : undefined;
  const png = fontGuid ? assets?.fontMsdfPng?.get(fontGuid) : undefined;
  const hasPair = Boolean(json && png && json.byteLength > 0 && (png instanceof Blob ? png.size : png.byteLength) > 0);
  if (parsed.renderer === "msdf" && !hasPair) warnMsdfFallback(fontGuid);
  const { stack: fontStack, pixelSize } = resolveText2DFont(fontGuid, assets);
  // A pixel font draws its own bitmap glyphs: a distance field would round them.
  const pixel = pixelSize > 0 && !options.metrics;
  const renderer = pixel ? "bitmap" : resolveText2DRenderer(parsed.renderer, hasPair);
  const glyphKey = (ch: string, style: RichTextStyle) =>
    pixel ? pixelGlyphKey(ch, style, fontStack, pixelSize) : bitmapGlyphKey(ch, style, fontStack);
  const bitmapCells = new Map<string, ReturnType<typeof rasterizeBitmapGlyph>>();
  const measured = new Map<string, ReturnType<typeof measureBitmapGlyph>>();
  const requests = new Map<string, { ch: string; style: RichTextStyle }>();
  // One canvas serves every unique glyph of this build (Play redraws on text edits).
  const canvasScratch: BitmapCanvasScratch = {};
  const pixelMeasured = new Map<string, NonNullable<ReturnType<typeof measurePixelGlyph>>>();
  const measure = (ch: string, style: RichTextStyle) => {
    const key = glyphKey(ch, style);
    let cell = measured.get(key);
    if (!cell) {
      const native = pixel ? measurePixelGlyph(ch, style, fontStack, pixelSize, canvasScratch) : null;
      if (native) pixelMeasured.set(key, native);
      cell = native ?? measureBitmapGlyph(ch, style, fontStack, canvasScratch);
      measured.set(key, cell);
      requests.set(key, { ch, style });
    }
    return bitmapCells.get(key) ?? { width: cell.layoutWidth, height: cell.layoutHeight };
  };
  const bitmap = options.metrics ?? (pixel ? pixelMetrics(ppu, pixelSize, (ch, style) => {
    measure(ch, style);
    return pixelMeasured.get(glyphKey(ch, style)) ?? null;
  }, measure) : bitmapMetrics(ppu, measure));
  const atlas = renderer === "msdf" && json ? msdfAtlasOf(json) : null;
  const metrics = options.metrics ?? (atlas ? msdfMetrics(atlas, ppu, bitmap) : bitmap);
  const layoutOptions = { rich, pixelsPerUnit: ppu, metrics };
  // A pixel font's base size is its Pixel Size times the text's whole-number Scale.
  const layoutProperties = pixel ? { ...parsed, size: pixelSize * parsed.pixelScale } : properties;
  const layOut = () => {
    const result = layoutText2DFromProperties(layoutProperties, layoutOptions).layout;
    return pixel ? snapLayoutToPixels(result, ppu) : result;
  };
  let layout = layOut();
  // A custom metrics provider may not have requested bitmap measurements.
  for (const item of layout.items) {
    if (item.kind === "glyph" && item.source !== "msdf" && item.ch?.trim() && !pixel) {
      measure(item.ch, item.style);
    }
  }
  const limits: BitmapAllocationLimits = {
    maxTextureSize: Math.min(options.bitmapLimits?.maxTextureSize ?? Infinity, scene.getEngine().getCaps().maxTextureSize),
    maxWorkingBytes: options.bitmapLimits?.maxWorkingBytes ?? DEFAULT_BITMAP_WORKING_BYTES,
    retainedBytes: options.bitmapLimits?.retainedBytes ?? 0,
  };
  // The text's glyphs share the Scene's atlas, but the limits stay those of a text that packed its own: what they
  // refused, they refuse.
  const hasBitmapGlyphs = planBitmapGlyphAtlas([...measured.values()], limits) !== null;
  const setup: Text2DSetup = {
    parsed, rich, fade, hitTest, ppu, fontGuid, png, fontStack, pixel, pixelSize, renderer, glyphKey, layout,
    bitmap: hasBitmapGlyphs,
  };
  const finish = (): Text2DPlan => {
    for (const [key, request] of requests) {
      const native = pixelMeasured.has(key) ? rasterizePixelGlyph(request.ch, request.style, fontStack, pixelSize, limits, canvasScratch) : null;
      bitmapCells.set(key, native ?? rasterizeBitmapGlyph(request.ch, request.style, fontStack, limits, measured.get(key), canvasScratch));
    }
    // Preserve the actual canvas/fallback cell metrics after the bounded raster pass.
    if (!options.metrics) layout = layOut();
    const atlas = sceneGlyphAtlas(scene, pixel);
    const glyphs = new Map<string, AtlasGlyph>();
    const held = [...bitmapCells.values()];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const cell of held.splice(0)) atlas.release(cell);
    };
    let bitmapBytes = 0;
    for (const [key, cell] of bitmapCells) {
      glyphs.set(key, atlas.acquire(cell));
      bitmapBytes += cell.width * cell.height * 8;
    }
    const wrapW =
      parsed.wrapWidth > 0 ? parsed.wrapWidth / ppu : Math.max(layout.width, 0.01);
    const wrapH =
      parsed.wrapHeight > 0 ? parsed.wrapHeight / ppu : Math.max(layout.height, 0.01);
    return { ...setup, layout, glyphs, bitmapBytes, release, wrapW, wrapH };
  };
  return { ...setup, finish };
}

/** The metadata a text's root carries about its laid-out size and atlas. */
function text2DSizeMetadata(plan: Text2DPlan) {
  const { parsed, layout, ppu, wrapW, wrapH } = plan;
  return {
    /** Laid-out width in pixels from the glyph cells actually drawn. */
    text2dLayoutWidth: layout.width * ppu,
    text2dBitmapBytes: plan.bitmapBytes,
    text2dWrapWidth: parsed.wrapWidth > 0 ? parsed.wrapWidth : wrapW * ppu,
    text2dWrapHeight: parsed.wrapHeight > 0 ? parsed.wrapHeight : wrapH * ppu,
  };
}

/** Whitespace advances the pen and draws nothing. */
const drawsLayoutItem = (item: Text2DLayoutItem): boolean => item.kind !== "glyph" || Boolean((item.ch ?? "").trim());

const drawsMsdf = (text: Text2DSetup, item: Text2DLayoutItem): boolean => item.source === "msdf" && text.renderer === "msdf";

/**
 * An MSDF glyph's binding depends only on these style fields; bold and italic are mesh transforms, so glyphs of one
 * style share a binding (and a batch).
 */
const msdfStyleKey = (item: Text2DLayoutItem): string =>
  `${item.style.color.join()}|${item.style.outline}|${item.style.outlineColor.join()}`;

/** The atlas glyph a bitmap item draws, once the text's glyphs are placed. */
const bitmapGlyphOf = (plan: Text2DPlan, item: Text2DLayoutItem): AtlasGlyph | undefined =>
  item.ch ? plan.glyphs.get(plan.glyphKey(item.ch, item.style)) : undefined;

/**
 * The batch `item` draws in, by the material its glyphs share (its MSDF style, or the atlas page of its bitmap
 * glyph), or null when it draws as a plane of its own. Static glyphs that share a material draw as one mesh per
 * material. A Text Material binds each glyph's own state and a reveal mode animates glyphs individually, so those
 * texts keep one plane per glyph, as do letter effects, images, underlines and glyphs with a private fallback
 * material. A measured text whose glyphs are not placed yet (no `glyphs`) counts its bitmap glyphs as one batch.
 */
function glyphBatchKey(text: Text2DSetup & { glyphs?: Text2DPlan["glyphs"] }, item: Text2DLayoutItem): string | null {
  const { parsed, rich } = text;
  if (parsed.materialGuid || (rich && parsed.appearModes.length > 0)) return null;
  if (item.kind !== "glyph" || hasLetterEffects(item)) return null;
  if (drawsMsdf(text, item)) return `msdf:${msdfStyleKey(item)}`;
  if (!item.ch || !text.bitmap) return null;
  if (!text.glyphs) return "bitmap";
  const glyph = text.glyphs.get(text.glyphKey(item.ch, item.style));
  return glyph ? `bitmap:${glyph.page.id}` : null;
}

/** A batch a text would draw: `page` is the atlas page of a bitmap batch whose glyphs are placed. */
type PlannedBatch = { key: string; index: number; quads: GlyphBatchQuad[]; page: GlyphAtlasPage | null };

/**
 * The batches a text's glyphs draw in, keyed as `glyphBatchKey` and in the order of each batch's first glyph (at
 * `index` in the layout), which is the order `createText2DMesh` creates them in; null when anything draws as a
 * plane of its own. `quad` fills each batch's quads.
 */
function glyphBatches(
  text: Text2DSetup & { glyphs?: Text2DPlan["glyphs"] },
  quad?: (item: Text2DLayoutItem) => GlyphBatchQuad,
): PlannedBatch[] | null {
  const batches = new Map<string, PlannedBatch>();
  for (let index = 0; index < text.layout.items.length; index++) {
    const item = text.layout.items[index]!;
    if (!drawsLayoutItem(item)) continue;
    const key = glyphBatchKey(text, item);
    if (!key) return null;
    let batch = batches.get(key);
    if (!batch) {
      const page = drawsMsdf(text, item) ? null : text.glyphs?.get(text.glyphKey(item.ch ?? "", item.style))?.page ?? null;
      batches.set(key, batch = { key, index, quads: [], page });
    }
    if (quad) batch.quads.push(quad(item));
  }
  return [...batches.values()];
}

function glyphBatchQuad(plan: Text2DPlan, item: Text2DLayoutItem): GlyphBatchQuad {
  const msdf = drawsMsdf(plan, item);
  const scale = item.style.bold && msdf ? 1.08 : 1;
  return {
    x: item.x,
    y: item.y,
    width: Math.max(item.width, 0.001),
    height: Math.max(item.height, 0.001),
    rotation: item.style.italic && msdf ? MSDF_ITALIC_SHEAR : 0,
    scaleX: scale,
    scaleY: scale,
    uvs: msdf ? item.uvs : bitmapGlyphOf(plan, item)?.uvs,
  };
}

/** A batch is named for its first glyph, at `index` in the layout. */
const glyphBatchName = (name: string, index: number): string => `${name}:glyphs:${index}`;

/**
 * Replaces the vertices of a mesh that already draws. Babylon does not recompute a frozen world matrix, which is
 * what moves new bounds to the mesh's place in the world, so those are refreshed here.
 */
function replaceVertexData(mesh: Mesh, data: VertexData): void {
  data.applyToMesh(mesh);
  if (mesh.isWorldMatrixFrozen) mesh.refreshBoundingInfo();
}

/**
 * Overlay 2D text: an AABB pick plane plus the glyph quads. Static glyphs that
 * share a material are one batch mesh per material; letter-effect, revealed,
 * Text Material, image, underline and fallback glyphs are one plane each.
 */
export function createText2DMesh(
  scene: Scene,
  name: string,
  properties: unknown,
  assets?: Text2DAssetContext,
  options: Text2DMeshOptions = {},
): Mesh {
  const plan = draftText2D(scene, properties, assets, options).finish();
  const { parsed, rich, fade, hitTest, ppu, fontGuid, png, fontStack, pixel, pixelSize, renderer, layout, wrapW, wrapH } = plan;
  const bundle = new VisualBundle();
  // The text holds its atlas glyphs until it is redrawn or disposed.
  const held = { release: plan.release };
  bundle.releaseWith(() => held.release());
  try {
    const parent = bundle.ownRenderUser(MeshBuilder.CreatePlane(name, { width: wrapW, height: wrapH }, scene));
    parent.onDisposeObservable.addOnce(() => bundle.dispose());
    // Drawn at zero visibility: a pick target only.
    setUnlitMaterial(parent, TEXT_SOLID, solidGlyphBinding([0, 0, 0], false));
    parent.visibility = 0;
    parent.isPickable = hitTest !== "ignore";
    parent.metadata = {
      ...(parent.metadata ?? {}),
      text2d: true,
      text2dRenderer: renderer,
      text2dRich: rich,
      text2dFontStack: fontStack,
      text2dPixelSize: pixel ? pixelSize : 0,
      ...text2DSizeMetadata(plan),
      visualBundle: bundle,
    };

    const atlasLease =
      renderer === "msdf" && fontGuid && png
        ? msdfAtlasTexture(scene, fontGuid, png, assets)
        : null;
    const atlasTexture = atlasLease?.resource ?? null;
    bundle.releaseWith(() => atlasLease?.release());
    // Glyphs on one atlas page share a binding: texts that bind the same values can share a draw.
    const bitmapBindings = new Map<GlyphAtlasPage, UnlitBinding>();
    const bitmapBindingFor = (page: GlyphAtlasPage): UnlitBinding => {
      let binding = bitmapBindings.get(page);
      if (!binding) bitmapBindings.set(page, binding = bitmapGlyphBinding(page.texture, fade));
      return binding;
    };

    const glyphMeshes: Array<{ mesh: Mesh; item: Text2DLayoutItem; restRotation: number }> =
      [];
    // Glyphs of one MSDF style share a binding. Without its atlas a glyph draws its solid colour.
    const msdfBindings = new Map<string, { key: UnlitMaterialKey; binding: UnlitBinding }>();
    const msdfBindingFor = (item: Text2DLayoutItem): { key: UnlitMaterialKey; binding: UnlitBinding } => {
      const styleKey = msdfStyleKey(item);
      let style = msdfBindings.get(styleKey);
      if (!style) {
        style = atlasTexture
          ? { key: TEXT_MSDF, binding: msdfGlyphBinding(atlasTexture, item.style) }
          : { key: TEXT_SOLID, binding: solidGlyphBinding(item.style.color, fade) };
        msdfBindings.set(styleKey, style);
      }
      return style;
    };
    const materialGlyphs: Array<{ mesh: Mesh; restore: () => void }> = [];
    const batches = new Map<string, GlyphBatch>();
    layout.items.forEach((item, index) => {
      if (!drawsLayoutItem(item)) return;
      const msdf = drawsMsdf(plan, item);
      const restRotation = item.style.italic && msdf ? MSDF_ITALIC_SHEAR : 0;
      const batchKey = glyphBatchKey(plan, item);
      if (batchKey) {
        let batch = batches.get(batchKey);
        if (!batch) {
          // Created at its first glyph so draw and child order follow glyph order.
          const mesh = new Mesh(glyphBatchName(name, index), scene);
          mesh.parent = parent;
          mesh.isPickable = false;
          const style = msdf ? msdfBindingFor(item) : null;
          if (style) setUnlitMaterial(mesh, style.key, style.binding);
          else setUnlitMaterial(mesh, TEXT_GLYPH, bitmapBindingFor(bitmapGlyphOf(plan, item)!.page));
          mesh.metadata = { text2dGlyph: true, text2dSource: item.source, text2dBatch: true };
          batch = { key: batchKey, mesh, quads: [] };
          batches.set(batchKey, batch);
        }
        batch.quads.push(glyphBatchQuad(plan, item));
        return;
      }
      const child = MeshBuilder.CreatePlane(
        `${name}:${item.kind}:${index}`,
        { width: Math.max(item.width, 0.001), height: Math.max(item.height, 0.001) },
        scene,
      );
      child.parent = parent;
      child.position.x = item.x;
      child.position.y = item.y;
      child.isPickable = false;
      child.rotation.z = restRotation;
      const bitmapGlyph = !msdf && item.kind === "glyph" ? bitmapGlyphOf(plan, item) : undefined;
      if (msdf) {
        const style = msdfBindingFor(item);
        setUnlitMaterial(child, style.key, style.binding);
        applyGlyphUvs(child, item.uvs);
      } else if (item.kind === "image") {
        setUnlitMaterial(child, TEXT_SOLID, solidGlyphBinding(item.style.color, fade));
        if (item.guid) applyAlbedoTexture(child, scene, item.guid, assets, { alwaysBlend: fade });
      } else if (item.kind === "underline") {
        setUnlitMaterial(child, TEXT_SOLID, solidGlyphBinding(item.style.color, fade));
      } else if (bitmapGlyph) {
        setUnlitMaterial(child, TEXT_GLYPH, bitmapBindingFor(bitmapGlyph.page));
        applyGlyphUvs(child, bitmapGlyph.uvs);
      } else {
        setUnlitMaterial(child, TEXT_SOLID, solidGlyphBinding(item.style.color, fade));
      }
      if (item.style.bold && msdf) {
        child.scaling.x = 1.08;
        child.scaling.y = 1.08;
      }
      child.metadata = {
        ...(child.metadata ?? {}),
        text2dGlyph: true,
        text2dSource: item.kind === "image" ? "image" : item.source,
      };
      if (item.kind !== "image") {
        const atlasUv = msdf ? item.uvs : item.ch ? bitmapGlyphOf(plan, item)?.uvs : undefined;
        const glyphAtlas = msdf ? atlasTexture : bitmapGlyph?.page.texture ?? null;
        bindTextMaterialGlyph(child, {
          atlas: glyphAtlas,
          mode: msdf && atlasTexture ? "msdf" : glyphAtlas ? "bitmap" : "solid",
          color: item.style.color,
          outlineColor: item.style.outlineColor,
          outline: item.style.outline,
          atlasRect: atlasUv ? [atlasUv.u0, atlasUv.v0, Math.max(1e-8, atlasUv.u1 - atlasUv.u0), Math.max(1e-8, atlasUv.v1 - atlasUv.v0)] : [0, 0, 1, 1],
          materialRect: parsed.materialUv === "glyph" ? [0, 0, 1, 1] : [
            (item.x - item.width / 2) / wrapW + 0.5,
            (item.y - item.height / 2) / wrapH + 0.5,
            item.width / wrapW, item.height / wrapH,
          ],
        });
        materialGlyphs.push({ mesh: child, restore: materialRestore(child) });
      }
      glyphMeshes.push({ mesh: child, item, restRotation });
    });

    for (const batch of batches.values()) {
      const { mesh } = batch;
      glyphBatchVertexData(batch.quads).applyToMesh(mesh);
      // An overlay-box resize counter-scales plane glyphs so letters keep their
      // size while the box scales; a batch re-poses the quads it draws to match.
      mesh.metadata = {
        ...mesh.metadata,
        text2dCounterScale: (counterX: number, counterY: number) => {
          const positions = new Float32Array(batch.quads.length * 12);
          writeGlyphBatchPositions(batch.quads, positions, counterX, counterY);
          if (mesh.isVertexBufferUpdatable(VertexBuffer.PositionKind)) mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
          else mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
        },
      };
    }

    textMaterialVisuals.set(parent, { guid: parsed.materialGuid, glyphs: materialGlyphs });
    refreshText2DMaterials(parent, assets);

    if (rich) {
      const count = layout.items.reduce((total, item) => Math.max(total, item.index + 1), 0);
      attachEffects(
        scene,
        parent,
        glyphMeshes,
        [...batches.values()].map((batch) => batch.mesh),
        bundle,
        parsed,
        count,
        ppu,
        options.isPaused ?? (() => assets?.paused === true),
      );
    }
    applyOverlayVisualStyle(parent, properties);
    textLayouts.set(parent, layout);
    text2DBuilds.set(parent, {
      name, rich, materialGuid: parsed.materialGuid, renderer, fontGuid, fontStack, pixelSize: pixel ? pixelSize : 0, hitTest,
      held, batches: [...batches.values()], planes: glyphMeshes.length, wrapW, wrapH,
    });
    parent.onDisposeObservable.addOnce(() => {
      textLayouts.delete(parent);
      text2DBuilds.delete(parent);
    });
    return parent;
  } catch (error) {
    bundle.dispose();
    throw error;
  }
}

/** A planned redraw of a text. One of the two must be called: the plan holds glyphs in the Scene's atlas. */
export type Text2DRedraw = {
  /** Redraws the text. */
  apply(): void;
  /** Gives the plan up, leaving the text as it is. */
  discard(): void;
};

/** Whether a batch draws MSDF glyphs (the rest draw bitmap glyphs from an atlas page). */
const isMsdfBatch = (key: string): boolean => key.startsWith("msdf:");

/**
 * Plans redrawing a text `createText2DMesh` built, for new properties, with the meshes and materials it already
 * owns, or returns null when the text cannot draw them that way. It can when the new text needs only what the text
 * has: plain text (not rich) without a Text Material, in the same font and renderer, whose glyphs all draw in
 * batches like the ones the text has (no underline, no new MSDF style, bitmap glyphs on as many atlas pages).
 * Applying the redraw makes the text draw the pixels `createText2DMesh` would: the same quads, each sampling the
 * same texels, with the same layout and size metadata. Nothing joins or leaves the Scene: a text a script rewrites
 * (a score, a timer) costs no Scene readiness probe and keeps drawing every frame. A text that cannot redraw for
 * what it is (Rich Text, a Text Material, an underline, another font) is turned down once it is measured, before
 * its glyphs are rasterized.
 *
 * `options` are those of a build; `bitmapLimits.retainedBytes` counts what stays alive while the text redraws. A text
 * the limits refuse throws here as it does in a build. The overlay style the text draws with is kept.
 */
export function text2DRedraw(
  root: Mesh,
  properties: unknown,
  assets?: Text2DAssetContext,
  options: Text2DMeshOptions = {},
): Text2DRedraw | null {
  const built = text2DBuilds.get(root);
  if (!built || root.isDisposed() || built.rich || options.rich === true || built.materialGuid || built.planes > 0) return null;
  const draft = draftText2D(root.getScene(), properties, assets, options);
  if (draft.parsed.materialGuid || draft.renderer !== built.renderer || draft.fontGuid !== built.fontGuid ||
    draft.fontStack !== built.fontStack || (draft.pixel ? draft.pixelSize : 0) !== built.pixelSize || draft.hitTest !== built.hitTest ||
    !glyphBatches(draft)) return null;
  const plan = draft.finish();
  const next = glyphBatches(plan, (item) => glyphBatchQuad(plan, item));
  // The same batches in the same order: MSDF batches of the same style, and bitmap batches, whose page may differ.
  if (!next || next.length !== built.batches.length || !next.every((batch, order) => {
    const key = built.batches[order]!.key;
    return isMsdfBatch(batch.key) ? batch.key === key : !isMsdfBatch(key);
  })) {
    plan.release();
    return null;
  }
  const { layout, wrapW, wrapH } = plan;

  return {
    discard: plan.release,
    apply() {
      next.forEach(({ key, index, quads, page }, order) => {
        const batch = built.batches[order]!;
        // Its glyphs now sit on another atlas page: the batch samples that one.
        if (batch.key !== key && page) setUnlitMaterial(batch.mesh, TEXT_GLYPH, bitmapGlyphBinding(page.texture, false));
        batch.key = key;
        batch.quads = quads;
        batch.mesh.name = batch.mesh.id = glyphBatchName(built.name, index);
        replaceVertexData(batch.mesh, glyphBatchVertexData(quads));
      });
      if (wrapW !== built.wrapW || wrapH !== built.wrapH) {
        replaceVertexData(root, CreatePlaneVertexData({ width: wrapW, height: wrapH }));
        built.wrapW = wrapW;
        built.wrapH = wrapH;
      }
      root.metadata = { ...(root.metadata ?? {}), ...text2DSizeMetadata(plan) };
      textLayouts.set(root, layout);
      // The glyphs drawn until now go only after the new ones are held, so a glyph both texts draw never leaves.
      built.held.release();
      built.held.release = plan.release;
    },
  };
}
