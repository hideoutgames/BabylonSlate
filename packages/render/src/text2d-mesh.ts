import {
  Color3,
  Effect,
  Material,
  Mesh,
  MeshBuilder,
  Observer,
  RawTexture,
  Scene,
  ShaderLanguage,
  ShaderMaterial,
  ShaderStore,
  StandardMaterial,
  Texture,
  VertexBuffer,
  type BaseTexture,
  type Nullable,
} from "@babylonjs/core";
import {
  parseSceneLayerHitTest,
  parseText2DProperties,
  resolveText2DRenderer,
  type RichTextStyle,
  type Text2DProperties,
} from "@babylonslate/core";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import {
  bitmapGlyphKey,
  DEFAULT_BITMAP_WORKING_BYTES,
  measureBitmapGlyph,
  packBitmapGlyphAtlas,
  planBitmapGlyphAtlas,
  rasterizeBitmapGlyph,
  resolveText2DFontStack,
  type BitmapAllocationLimits,
} from "./text2d-bitmap";
import { VisualBundle } from "./visual-bundle";
import {
  combineText2DEffects,
  layoutHasLetterEffects,
  layoutText2DFromProperties,
  type GlyphMetricsProvider,
  type Text2DEffectSample,
  type Text2DLayout,
  type Text2DLayoutItem,
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

const MSDF_SHADER = "text2dMsdf";
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
export function parseMsdfAtlas(bytes: Uint8Array): MsdfAtlas | null {
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

function defaultMetrics(pixelsPerUnit: number): GlyphMetricsProvider {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  return {
    measureGlyph(_ch, style) {
      const world = style.size / ppu;
      return {
        width: world * 0.5,
        height: world,
        bearingX: 0,
        bearingY: 0,
        advance: world * 0.5,
        source: "bitmap",
      };
    },
    measureImage(_guid, sizePx) {
      const height = sizePx / ppu;
      return { width: height, height };
    },
  };
}

/** Quad size follows the raster cell so 5×7 fallback is not stretched to measureText. */
function bitmapMetrics(
  pixelsPerUnit: number,
  measure: (ch: string, style: RichTextStyle) => { width: number; height: number },
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
      };
    },
    measureImage(_guid, sizePx) {
      const height = sizePx / ppu;
      return { width: height, height };
    },
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

function bitmapGlyphMaterial(scene: Scene, name: string, atlas: Texture, bundle: VisualBundle): StandardMaterial {
  const material = bundle.ownMaterial(new StandardMaterial(name, scene));
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveTexture = atlas;
  material.diffuseTexture = atlas;
  atlas.hasAlpha = true;
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = Material.MATERIAL_ALPHATEST;
  material.alphaCutOff = 0.4;
  material.metadata = { ...(material.metadata ?? {}), bitmapAtlas: true };
  return material;
}

function unlitMaterial(
  scene: Scene,
  name: string,
  color: [number, number, number],
  msdf: boolean,
  bundle: VisualBundle,
): StandardMaterial {
  const material = bundle.ownMaterial(new StandardMaterial(name, scene));
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.emissiveColor = new Color3(color[0], color[1], color[2]);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.metadata = { ...(material.metadata ?? {}), msdf };
  return material;
}

function ensureMsdfShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${MSDF_SHADER}VertexShader`] = `
attribute position: vec3f;
attribute uv: vec2f;
uniform worldViewProjection: mat4x4f;
varying vUV: vec2f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;
  ShaderStore.ShadersStoreWGSL[`${MSDF_SHADER}FragmentShader`] = `
varying vUV: vec2f;
var atlasSampler: sampler;
var atlas: texture_2d<f32>;
uniform fillColor: vec3f;
uniform strokeColor: vec3f;
uniform strokeWidth: f32;
fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let msd = textureSample(atlas, atlasSampler, fragmentInputs.vUV).rgb;
  let sd = median(msd.r, msd.g, msd.b);
  let screenPxDistance = fwidth(sd) * 0.5;
  let fill = clamp((sd - 0.5) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0);
  let outline = select(fill, clamp((sd - 0.5 + uniforms.strokeWidth) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0), uniforms.strokeWidth > 0.0);
  let color = mix(uniforms.strokeColor, uniforms.fillColor, fill);
  let alpha = max(fill, outline);
  if (alpha < 0.01) { discard; }
  fragmentOutputs.color = vec4f(color, alpha);
}
`;
  Effect.ShadersStore[`${MSDF_SHADER}VertexShader`] = `
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
  Effect.ShadersStore[`${MSDF_SHADER}FragmentShader`] = `
varying vec2 vUV;
uniform sampler2D atlas;
uniform vec3 fillColor;
uniform vec3 strokeColor;
uniform float strokeWidth;
float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  vec3 msd = texture2D(atlas, vUV).rgb;
  float sd = median(msd.r, msd.g, msd.b);
  float screenPxDistance = fwidth(sd) * 0.5;
  float fill = clamp((sd - 0.5) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0);
  float outline = strokeWidth > 0.0
    ? clamp((sd - 0.5 + strokeWidth) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0)
    : fill;
  vec3 color = mix(strokeColor, fillColor, fill);
  float alpha = max(fill, outline);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}
`;
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

function msdfGlyphMaterial(
  scene: Scene,
  name: string,
  color: [number, number, number],
  outline: number,
  outlineColor: [number, number, number],
  atlas: BaseTexture | null,
  bundle: VisualBundle,
): Material {
  if (!atlas) return unlitMaterial(scene, name, color, true, bundle);
  try {
    ensureMsdfShaders();
    const material = bundle.ownMaterial(new ShaderMaterial(
      name,
      scene,
      { vertex: MSDF_SHADER, fragment: MSDF_SHADER },
      {
        shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection", "fillColor", "strokeColor", "strokeWidth"],
        samplers: ["atlas"],
        needAlphaBlending: true,
      },
    ));
    material.backFaceCulling = false;
    material.setTexture("atlas", atlas);
    material.setColor3("fillColor", new Color3(color[0], color[1], color[2]));
    material.setColor3(
      "strokeColor",
      new Color3(outlineColor[0], outlineColor[1], outlineColor[2]),
    );
    material.setFloat("strokeWidth", Math.max(0, outline) * 0.08);
    material.metadata = { ...(material.metadata ?? {}), msdf: true };
    return material;
  } catch {
    const fallback = unlitMaterial(scene, name, color, true, bundle);
    fallback.emissiveTexture = atlas as Texture;
    fallback.opacityTexture = atlas as Texture;
    return fallback;
  }
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
  bundle: VisualBundle,
  isPaused?: () => boolean,
): void {
  if (!glyphs.some((entry) => hasLetterEffects(entry.item))) return;
  const last = new Map<Mesh, Text2DEffectSample>();
  const tick = (time: number) => {
    const paused = isPaused?.() === true;
    for (const { mesh, item, restRotation } of glyphs) {
      const sample = combineText2DEffects(item.effects, {
        time,
        index: item.index,
        fontSize: item.height,
        hoverPhase: item.hoverPhase,
        rotatePhase: item.rotatePhase,
        paused,
        last: last.get(mesh),
      });
      last.set(mesh, sample);
      mesh.position.x = item.x + sample.x;
      mesh.position.y = item.y + sample.y;
      mesh.rotation.z = restRotation + sample.rotation;
    }
  };
  let elapsed = 0;
  const observer: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
    if (isPaused?.()) return;
    elapsed += scene.getEngine().getDeltaTime() / 1000;
    tick(elapsed);
  });
  bundle.cancelWith(() => {
    if (observer) scene.onBeforeRenderObservable.remove(observer);
  });
  parent.metadata = {
    ...(parent.metadata ?? {}),
    tickText2DEffects: tick,
  };
}

/** Overlay 2D text: AABB pick plane + per-glyph (and inline image) quads. */
export function createText2DMesh(
  scene: Scene,
  name: string,
  properties: unknown,
  assets?: Text2DAssetContext,
  options: Text2DMeshOptions = {},
): Mesh {
  const rich = options.rich === true;
  const parsed = parseText2DProperties(properties, { rich });
  const hitTest = parseSceneLayerHitTest(parsed.hitTest, "ignore");
  const ppu = assets?.pixelsPerUnit && assets.pixelsPerUnit > 0 ? assets.pixelsPerUnit : 100;
  const fontGuid = parsed.fontAssetGuid;
  const json = fontGuid ? assets?.fontMsdfJson?.get(fontGuid) : undefined;
  const png = fontGuid ? assets?.fontMsdfPng?.get(fontGuid) : undefined;
  const hasPair = Boolean(json && png && json.byteLength > 0 && (png instanceof Blob ? png.size : png.byteLength) > 0);
  if (parsed.renderer === "msdf" && !hasPair) warnMsdfFallback(fontGuid);
  const renderer = resolveText2DRenderer(parsed.renderer, hasPair);
  const fontStack = resolveText2DFontStack(fontGuid, assets);
  const bitmapCells = new Map<string, ReturnType<typeof rasterizeBitmapGlyph>>();
  const measured = new Map<string, ReturnType<typeof measureBitmapGlyph>>();
  const requests = new Map<string, { ch: string; style: RichTextStyle }>();
  const measure = (ch: string, style: RichTextStyle) => {
    const key = bitmapGlyphKey(ch, style, fontStack);
    let cell = measured.get(key);
    if (!cell) {
      cell = measureBitmapGlyph(ch, style, fontStack);
      measured.set(key, cell);
      requests.set(key, { ch, style });
    }
    return bitmapCells.get(key) ?? { width: cell.layoutWidth, height: cell.layoutHeight };
  };
  const bitmap = options.metrics ?? bitmapMetrics(ppu, measure);
  const atlas = renderer === "msdf" && json ? parseMsdfAtlas(json) : null;
  const metrics = options.metrics ?? (atlas ? msdfMetrics(atlas, ppu, bitmap) : bitmap);
  const layoutOptions = { rich, pixelsPerUnit: ppu, metrics };
  let { layout } = layoutText2DFromProperties(properties, layoutOptions);
  // A custom metrics provider may not have requested bitmap measurements.
  for (const item of layout.items) {
    if (item.kind === "glyph" && item.source !== "msdf" && item.ch?.trim()) {
      measure(item.ch, item.style);
    }
  }
  const limits: BitmapAllocationLimits = {
    maxTextureSize: Math.min(options.bitmapLimits?.maxTextureSize ?? Infinity, scene.getEngine().getCaps().maxTextureSize),
    maxWorkingBytes: options.bitmapLimits?.maxWorkingBytes ?? DEFAULT_BITMAP_WORKING_BYTES,
    retainedBytes: options.bitmapLimits?.retainedBytes ?? 0,
  };
  const bitmapPlan = planBitmapGlyphAtlas([...measured.values()], limits);
  for (const [key, request] of requests) {
    bitmapCells.set(key, rasterizeBitmapGlyph(request.ch, request.style, fontStack, limits, measured.get(key)));
  }
  // Preserve the actual canvas/fallback cell metrics after the bounded raster pass.
  if (!options.metrics) layout = layoutText2DFromProperties(properties, layoutOptions).layout;
  const packedBitmap = packBitmapGlyphAtlas([...bitmapCells.values()], limits, bitmapPlan);
  const wrapW =
    parsed.wrapWidth > 0 ? parsed.wrapWidth / ppu : Math.max(layout.width, 0.01);
  const wrapH =
    parsed.wrapHeight > 0 ? parsed.wrapHeight / ppu : Math.max(layout.height, 0.01);
  const bundle = new VisualBundle();
  try {
    const parent = bundle.ownRenderUser(MeshBuilder.CreatePlane(name, { width: wrapW, height: wrapH }, scene));
    parent.onDisposeObservable.addOnce(() => bundle.dispose());
    parent.material = unlitMaterial(scene, `${name}:pick`, [0, 0, 0], false, bundle);
    parent.visibility = 0;
    parent.isPickable = hitTest !== "ignore";
    parent.metadata = {
      ...(parent.metadata ?? {}),
      text2d: true,
      text2dRenderer: renderer,
      text2dRich: rich,
      text2dFontStack: fontStack,
      text2dBitmapBytes: packedBitmap ? packedBitmap.width * packedBitmap.height * 8 : 0,
      visualBundle: bundle,
      text2dWrapWidth: parsed.wrapWidth > 0 ? parsed.wrapWidth : wrapW * ppu,
      text2dWrapHeight: parsed.wrapHeight > 0 ? parsed.wrapHeight : wrapH * ppu,
    };

    const atlasLease =
      renderer === "msdf" && fontGuid && png
        ? msdfAtlasTexture(scene, fontGuid, png, assets)
        : null;
    const atlasTexture = atlasLease?.resource ?? null;
    bundle.releaseWith(() => atlasLease?.release());
    let bitmapAtlas: RawTexture | null = null;
    let sharedBitmapMaterial: StandardMaterial | null = null;
    if (packedBitmap) {
      bitmapAtlas = bundle.ownTexture(RawTexture.CreateRGBATexture(
        packedBitmap.pixels,
        packedBitmap.width,
        packedBitmap.height,
        scene,
        false,
        true,
        Texture.BILINEAR_SAMPLINGMODE,
      ));
      bitmapAtlas.hasAlpha = true;
      bitmapAtlas.name = `${name}:bitmap-atlas`;
      sharedBitmapMaterial = bitmapGlyphMaterial(scene, `${name}:bitmap`, bitmapAtlas, bundle);
    }

    const glyphMeshes: Array<{ mesh: Mesh; item: Text2DLayoutItem; restRotation: number }> =
      [];
    layout.items.forEach((item, index) => {
      if (item.kind === "glyph" && !(item.ch ?? "").trim()) return;
      const child = MeshBuilder.CreatePlane(
        `${name}:${item.kind}:${index}`,
        { width: Math.max(item.width, 0.001), height: Math.max(item.height, 0.001) },
        scene,
      );
      child.parent = parent;
      child.position.x = item.x;
      child.position.y = item.y;
      child.isPickable = false;
      const msdf = item.source === "msdf" && renderer === "msdf";
      const restRotation = item.style.italic && msdf ? MSDF_ITALIC_SHEAR : 0;
      child.rotation.z = restRotation;
      if (msdf) {
        child.material = msdfGlyphMaterial(
          scene,
          `${name}:glyph:${index}`,
          item.style.color,
          item.style.outline,
          item.style.outlineColor,
          atlasTexture,
          bundle,
        );
        applyGlyphUvs(child, item.uvs);
      } else if (item.kind === "image") {
        child.material = unlitMaterial(scene, `${name}:glyph:${index}`, item.style.color, false, bundle);
        if (item.guid) applyAlbedoTexture(child, scene, item.guid, assets);
      } else if (item.kind === "underline") {
        child.material = unlitMaterial(scene, `${name}:glyph:${index}`, item.style.color, false, bundle);
      } else if (sharedBitmapMaterial && packedBitmap && item.ch) {
        child.material = sharedBitmapMaterial;
        applyGlyphUvs(
          child,
          packedBitmap.uvs.get(bitmapGlyphKey(item.ch, item.style, fontStack)),
        );
      } else {
        child.material = unlitMaterial(scene, `${name}:glyph:${index}`, item.style.color, false, bundle);
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
      glyphMeshes.push({ mesh: child, item, restRotation });
    });

    if (rich && layoutHasLetterEffects(layout)) {
      attachEffects(scene, parent, glyphMeshes, bundle, options.isPaused ?? (() => assets?.paused === true));
    }
    return parent;
  } catch (error) {
    bundle.dispose();
    throw error;
  }
}

export function text2dPropertiesFromUnknown(
  properties: unknown,
  rich = false,
): Text2DProperties {
  return parseText2DProperties(properties, { rich });
}

export function layoutForText2D(
  properties: unknown,
  assets: Text2DAssetContext | undefined,
  options: Text2DMeshOptions,
): Text2DLayout {
  const ppu = assets?.pixelsPerUnit && assets.pixelsPerUnit > 0 ? assets.pixelsPerUnit : 100;
  return layoutText2DFromProperties(properties, {
    rich: options.rich === true,
    pixelsPerUnit: ppu,
    metrics: options.metrics ?? defaultMetrics(ppu),
  }).layout;
}
