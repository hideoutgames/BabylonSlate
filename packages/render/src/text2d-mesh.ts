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
  text2DCharacterReveal,
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
  type BitmapCanvasScratch,
  type BitmapGlyphCell,
} from "./text2d-bitmap";
import { VisualBundle } from "./visual-bundle";
import { bindTextMaterialGlyph } from "./text-material-block";
import { applyOverlayVisualStyle, overlayVisualStyle } from "./overlay-visual-style";
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

const textMaterialVisuals = new WeakMap<Mesh, { guid: string | null; glyphs: Array<{ mesh: Mesh; fallback: Material | null }> }>();
const appearVisuals = new WeakMap<Mesh, (progress: number) => void>();
const textLayouts = new WeakMap<Mesh, Text2DLayout>();

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
    for (const glyph of entry.glyphs) glyph.mesh.material = accepted ?? glyph.fallback;
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

const MSDF_SHADER = "text2dMsdf";
const MSDF_ITALIC_SHEAR = -0.2;
const loggedMsdfFallback = new Set<string>();
let msdfShadersRegistered = false;

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

function bitmapGlyphMaterial(scene: Scene, name: string, atlas: Texture, bundle: VisualBundle, fade: boolean): StandardMaterial {
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
  material.transparencyMode = fade ? Material.MATERIAL_ALPHABLEND : Material.MATERIAL_ALPHATEST;
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
  if (msdfShadersRegistered) return;
  msdfShadersRegistered = true;
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
uniform glyphOpacity: f32;
uniform overlayTint: vec4f;
uniform linearOutput: f32;
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
  var color = mix(uniforms.strokeColor, uniforms.fillColor, fill);
  if (uniforms.linearOutput > 0.5) { color = pow(max(color, vec3f(0.0)), vec3f(2.2)); }
  let alpha = max(fill, outline) * uniforms.glyphOpacity;
  if (alpha < 0.01) { discard; }
  fragmentOutputs.color = vec4f(color, alpha) * uniforms.overlayTint;
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
uniform float glyphOpacity;
uniform vec4 overlayTint;
uniform float linearOutput;
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
  if (linearOutput > 0.5) color = pow(max(color, vec3(0.0)), vec3(2.2));
  float alpha = max(fill, outline) * glyphOpacity;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha) * overlayTint;
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
        uniforms: ["worldViewProjection", "fillColor", "strokeColor", "strokeWidth", "glyphOpacity", "overlayTint", "linearOutput"],
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
    material.setFloat("glyphOpacity", 1);
    material.onBindObservable.add((mesh) => {
      material.getEffect()?.setFloat("glyphOpacity", mesh?.visibility ?? 1);
      const { opacity, tint } = overlayVisualStyle(mesh);
      material.getEffect()?.setFloat4("overlayTint", tint[0], tint[1], tint[2], tint[3] * opacity);
      // Glyph colors are display-space. Like Standard materials, decode them
      // for a Scene Linear display stage, which encodes the frame once.
      material.getEffect()?.setFloat("linearOutput", scene.imageProcessingConfiguration.applyByPostProcess ? 1 : 0);
    });
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
  const fade = rich && parsed.appearModes.includes("fade");
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
  // One canvas serves every unique glyph of this build (Play rebuilds on text edits).
  const canvasScratch: BitmapCanvasScratch = {};
  const measure = (ch: string, style: RichTextStyle) => {
    const key = bitmapGlyphKey(ch, style, fontStack);
    let cell = measured.get(key);
    if (!cell) {
      cell = measureBitmapGlyph(ch, style, fontStack, canvasScratch);
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
    bitmapCells.set(key, rasterizeBitmapGlyph(request.ch, request.style, fontStack, limits, measured.get(key), canvasScratch));
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
      sharedBitmapMaterial = bitmapGlyphMaterial(scene, `${name}:bitmap`, bitmapAtlas, bundle, fade);
    }

    const glyphMeshes: Array<{ mesh: Mesh; item: Text2DLayoutItem; restRotation: number }> =
      [];
    // MSDF uniforms depend only on these style fields; bold and italic are
    // mesh transforms, so glyphs of one style share a bundle-owned material.
    const msdfMaterials = new Map<string, Material>();
    const materialGlyphs: Array<{ mesh: Mesh; fallback: Material | null }> = [];
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
        const styleKey = `${item.style.color.join()}|${item.style.outline}|${item.style.outlineColor.join()}`;
        let material = msdfMaterials.get(styleKey);
        if (!material) {
          material = msdfGlyphMaterial(
            scene,
            `${name}:glyph:${index}`,
            item.style.color,
            item.style.outline,
            item.style.outlineColor,
            atlasTexture,
            bundle,
          );
          msdfMaterials.set(styleKey, material);
        }
        child.material = material;
        applyGlyphUvs(child, item.uvs);
      } else if (item.kind === "image") {
        child.material = unlitMaterial(scene, `${name}:glyph:${index}`, item.style.color, false, bundle);
        if (item.guid) applyAlbedoTexture(child, scene, item.guid, assets, { alwaysBlend: fade });
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
      if (fade && child.material instanceof StandardMaterial) {
        child.material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      }
      child.metadata = {
        ...(child.metadata ?? {}),
        text2dGlyph: true,
        text2dSource: item.kind === "image" ? "image" : item.source,
      };
      if (item.kind !== "image") {
        const atlasUv = msdf ? item.uvs : item.ch ? packedBitmap?.uvs.get(bitmapGlyphKey(item.ch, item.style, fontStack)) : undefined;
        const glyphAtlas = msdf ? atlasTexture : item.kind === "glyph" ? bitmapAtlas : null;
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
        materialGlyphs.push({ mesh: child, fallback: child.material });
      }
      glyphMeshes.push({ mesh: child, item, restRotation });
    });

    textMaterialVisuals.set(parent, { guid: parsed.materialGuid, glyphs: materialGlyphs });
    refreshText2DMaterials(parent, assets);

    if (rich) {
      const count = layout.items.reduce((total, item) => Math.max(total, item.index + 1), 0);
      attachEffects(scene, parent, glyphMeshes, bundle, parsed, count, ppu, options.isPaused ?? (() => assets?.paused === true));
    }
    applyOverlayVisualStyle(parent, properties);
    textLayouts.set(parent, layout);
    parent.onDisposeObservable.addOnce(() => textLayouts.delete(parent));
    return parent;
  } catch (error) {
    bundle.dispose();
    throw error;
  }
}
