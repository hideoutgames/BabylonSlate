import { Camera, Constants, Matrix, RawTexture, ThinTexture, Vector3, type DirectionalLight, type Effect, type Scene } from "@babylonjs/core";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import type { ScreenShadowsQuality } from "@haptic/core";
import { syntax } from "./ambient-occlusion-shader";
import type { EffectCompileFailure } from "./effect-compile-failure";
import { hapticShadowedSun } from "./haptic-lights";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { AtlasCascadedShadowGenerator, shadowTileSize } from "./shadow-atlas";
import { SHADOW_FILTER_REACH_TEXELS } from "./shadow-filter";
import { customWrapper } from "./spatial-effects";

/**
 * Screen-Space Shadows: before the objects draw, a full-resolution pass marches from each pixel of the spatial geometry
 * pass's depth toward the shadowed sun and writes RG16F (R: the sun's lit share, G: the eye distance of the surface it
 * marched from). Only pixels the geometry pass marks as a shadow caster's (its depth's G channel, `meshCastsShadows`)
 * occlude, so Cast Shadows holds for the march as for the map. The light block reads it at its own pixel for a surface at
 * that distance, so glass, water and anything the geometry pass did not see in front keep the sun's map alone, and
 * combines it with the cascades by min, on receivers only.
 *
 * The march only sees each surface's front, so it assumes a surface it passes behind is some thickness deep. It adds the
 * contact shadows finer than the sun's cascades resolve; a deeper occluder is the cascades' to shadow. So the assumed
 * thickness is capped at the filter's reach in the world of the cascade at the pixel's depth (`screenShadowThicknessCaps`),
 * never less than the ray's depth change over one step, so no crossing falls between two steps. Without that cap a ray
 * passing a few tenths of a metre behind a nearer object (a limb beside a head) read as blocked where the cascades,
 * at a centimetre a texel, show the sun reaching it.
 */

/** Per level: march steps, the march's screen cap in pixels and world cap in metres, and the eye-distance fade. */
export const SCREEN_SHADOW_LEVELS: Record<Exclude<ScreenShadowsQuality, "off">, {
  steps: number; pixels: number; length: number; fadeStart: number; fadeEnd: number;
}> = {
  low: { steps: 6, pixels: 30, length: 0.35, fadeStart: 12, fadeEnd: 20 },
  medium: { steps: 12, pixels: 48, length: 0.6, fadeStart: 20, fadeEnd: 35 },
  high: { steps: 16, pixels: 64, length: 0.8, fadeStart: 30, fadeEnd: 50 },
};
const MAX_STEPS = 16;

/**
 * The march (GLSL or WGSL). Uniforms: `ssProjection`, `ssInverseProjection` (the camera's projection, which the geometry pass
 * drew with), `ssSun` (the view-space direction toward the sun; w 0 writes lit: no shadowed
 * sun, an orthographic view), `ssMarch` (steps, pixel cap, world cap; w unused), `ssFade` (fade start and end, the
 * render height times the projection's y scale), `ssTexel`, `ssCascadeEnds` and `ssCascadeCaps` (`screenShadowThicknessCaps`;
 * an unused cascade ends at -1). Derivatives come first: WGSL takes them in uniform control flow.
 */
export function screenShadowsShader(wgsl: boolean): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, sample, loop, output, main } = syntax(wgsl);
  const lit = (eye: string) => output(`${v4}(1.0, ${eye}, 0.0, 1.0)`);
  const header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("depthSampler")}
${field(wgsl ? "mat4x4f" : "mat4", "ssProjection")}${field(wgsl ? "mat4x4f" : "mat4", "ssInverseProjection")}
${field(v4, "ssSun")}${field(v4, "ssMarch")}${field(v4, "ssFade")}${field(v2, "ssTexel")}${field(v4, "ssCascadeEnds")}${field(v4, "ssCascadeCaps")}
`;
  const body = `
${decl(f, "depth", `abs(${sample("depthSampler", uv)}.r)`)}
${decl(v4, "unprojected", `${u("ssInverseProjection")} * ${v4}(${uv} * 2.0 - ${v2}(1.0), 0.5, 1.0)`)}
${decl(v3, "viewPoint", "unprojected.xyz / unprojected.w")}
${decl(v3, "P", "viewPoint * (depth / max(abs(viewPoint.z), 0.000001))")}
${decl(v3, "dx", wgsl ? "dpdx(P)" : "dFdx(P)")}
${decl(v3, "dy", wgsl ? "dpdy(P)" : "dFdy(P)")}
${decl(f, "eye", "length(P)")}
if (${u("ssSun")}.w < 0.5 || depth < 0.000001 || eye >= ${u("ssFade")}.y) { ${lit("eye")} }
${decl(v3, "N", "cross(dx, dy)")}
if (dot(N, N) < 1e-12) { ${lit("eye")} }
N = normalize(N);
if (dot(N, P) > 0.0) { N = -N; }
${decl(v3, "L", `${u("ssSun")}.xyz`)}
${decl(f, "NdotL", "dot(N, L)")}
if (NdotL <= 0.0) { ${lit("eye")} }
${decl(f, "footprint", `2.0 * depth / ${u("ssFade")}.z`)}
${decl(f, "reach", `min(${u("ssMarch")}.z, ${u("ssMarch")}.y * footprint)`)}
${decl(f, "bias", "(0.004 * depth + 0.01) / max(NdotL, 0.25)")}
// The deepest a surface the ray passes behind is taken to be: 0.15 m + 0.02 z, at most the bias plus the reach of the
// cascade filtering this depth (none beyond the last), and at least the bias plus the ray's depth change over a step.
${decl(v4, "ends", u("ssCascadeEnds"))}
${decl(v4, "caps", u("ssCascadeCaps"))}
${decl(f, "cap", "1.0e4")}
if (depth <= ends.w) { cap = caps.w; }
if (depth <= ends.z) { cap = caps.z; }
if (depth <= ends.y) { cap = caps.y; }
if (depth <= ends.x) { cap = caps.x; }
${decl(f, "stepDepth", `abs(L.z) * reach / ${u("ssMarch")}.x`)}
${decl(f, "thickness", "min(0.15 + 0.02 * depth, bias + max(stepDepth, cap))")}
${decl(v3, "start", "P + L * (1.5 * footprint)")}
${decl(v2, "pixel", `floor(${uv} / ${u("ssTexel")})`)}
${decl(f, "dither", `fract(52.9829189 * fract(dot(pixel, ${v2}(0.06711056, 0.00583715))))`)}
${decl(f, "occlusion", "0.0")}
${loop("i", 0, MAX_STEPS)} {
  if (${f}(i) >= ${u("ssMarch")}.x) { break; }
  ${decl(f, "t", `(${f}(i) + dither) / ${u("ssMarch")}.x * reach`)}
  ${decl(v3, "q", "start + L * t")}
  ${decl(v4, "clip", `${u("ssProjection")} * ${v4}(q, 1.0)`)}
  if (clip.w <= 0.0) { break; }
  ${decl(v2, "at", "clip.xy / clip.w * 0.5 + 0.5")}
  if (at.x < 0.0 || at.y < 0.0 || at.x > 1.0 || at.y > 1.0) { break; }
  ${decl(v2, "stored", `${sample("depthSampler", "at")}.rg`)}
  ${decl(f, "scene", "abs(stored.x)")}
  ${decl(f, "delta", "abs(q.z) - scene")}
  // Only a shadow caster's pixel occludes (the geometry pass's caster mark, G).
  if (stored.y > 0.5 && scene > 0.000001 && delta > bias && delta < thickness) {
    ${decl(f, "edge", "min(min(at.x, 1.0 - at.x), min(at.y, 1.0 - at.y))")}
    occlusion = max(occlusion, (1.0 - 0.5 * t / reach) * clamp(edge * 20.0, 0.0, 1.0));
  }
}
${decl(f, "fade", `1.0 - smoothstep(${u("ssFade")}.x, ${u("ssFade")}.y, eye)`)}
${output(`${v4}(1.0 - occlusion * fade, eye, 0.0, 1.0)`)}
`;
  return header + main(body);
}

const NO_CASCADES = [-1, -1, -1, -1] as const;

/**
 * What the march takes a surface's thickness to be at most, per cascade of `light`'s map as `camera` samples it (its
 * own map, else the light's): its far end in view depth and its filter's reach in metres (`SHADOW_FILTER_REACH_TEXELS`
 * of its world texels, on the coarser axis), four each, an unused cascade ending at -1. Null without a cascaded map in
 * the atlas, or before its cascades were first drawn: the march then keeps its general thickness.
 */
export function screenShadowThicknessCaps(light: DirectionalLight, camera: Camera):
  { ends: [number, number, number, number]; caps: [number, number, number, number] } | null {
  const own = light.getShadowGenerator(camera);
  const shadow = own instanceof AtlasCascadedShadowGenerator ? own : light.getShadowGenerator();
  if (!(shadow instanceof AtlasCascadedShadowGenerator) || !shadow.cascadeEnds.length) return null;
  const ends: [number, number, number, number] = [-1, -1, -1, -1];
  const caps: [number, number, number, number] = [0, 0, 0, 0];
  for (let index = 0; index < Math.min(4, shadow.cascadeEnds.length); index++) {
    const min = shadow.getCascadeMinExtents(index), max = shadow.getCascadeMaxExtents(index);
    const size = shadowTileSize(shadow, index);
    if (!min || !max || !(size > 0)) return null;
    ends[index] = shadow.cascadeEnds[index]!;
    caps[index] = SHADOW_FILTER_REACH_TEXELS * Math.max(max.x - min.x, max.y - min.y) / size;
  }
  return { ends, caps };
}

type PassEntry = { texture: ThinTexture };
const registries = new WeakMap<Scene, Map<number, PassEntry>>();
const placeholders = new WeakMap<Scene, ThinTexture>();

/** The screen shadows the draw of `renderPassId` reads, or null: any pass but a planned view's objects passes. */
export function screenShadowsForPass(scene: Scene, renderPassId: number): ThinTexture | null {
  const texture = registries.get(scene)?.get(renderPassId)?.texture;
  return texture?.getInternalTexture() ? texture : null;
}

/** A lit 1 × 1 texture every program declaring the screen shadows binds where its pass has none (WebGPU binds every declared texture). */
export function screenShadowsPlaceholder(scene: Scene): ThinTexture {
  let texture = placeholders.get(scene);
  if (!texture) {
    const raw = RawTexture.CreateRGBATexture(new Uint8Array([255, 0, 0, 255]), 1, 1, scene.getEngine(), false, false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    raw.name = "haptic:screenShadowsPlaceholder";
    texture = raw;
    placeholders.set(scene, raw);
    scene.onDisposeObservable.addOnce(() => {
      placeholders.delete(scene);
      raw.dispose();
    });
  }
  return texture;
}

class ScreenShadowsTask extends FrameGraphPostProcessTask {
  private retirement: OwnedEffectRetirement | undefined;
  private readonly depth: FrameGraphTextureHandle;
  private readonly bind: (effect: Effect) => void;
  constructor(graph: FrameGraph, wrapper: ReturnType<typeof customWrapper>, depth: FrameGraphTextureHandle, bind: (effect: Effect) => void) {
    super(wrapper.name, graph, wrapper);
    this.depth = depth;
    this.bind = bind;
    this.depthTest = false;
  }
  override record() {
    const pass = super.record(true, undefined, (context) => {
      const effect = this.drawWrapper.effect!;
      context.setTextureSamplingMode(this.depth, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
      context.bindTextureHandle(effect, "depthSampler", this.depth);
      this.bind(effect);
    });
    pass.addDependencies(this.depth);
    return pass;
  }
  override dispose(): void {
    this.retirement ??= retireOwnedEffect(this.postProcess.effect, () => super.dispose());
  }
  whenDisposed(): Promise<void> {
    return this.retirement?.completion ?? Promise.resolve();
  }
  whenReleased(): Promise<void> {
    return this.retirement?.released ?? Promise.resolve();
  }
}

/**
 * One view's screen shadows: the task (after the geometry pass, before the objects), its RG16F target and the objects
 * passes that read it. It never idles on light state: without a shadowed sun it writes lit through a uniform, so the
 * sun starting to cast shadows creates no pipeline.
 */
export class ScreenShadowsGraph {
  readonly task: ScreenShadowsTask;
  readonly output: FrameGraphTextureHandle;
  private readonly entries = new Map<number, PassEntry>();
  private readonly scene: Scene;

  constructor(
    graph: FrameGraph, camera: Camera, level: Exclude<ScreenShadowsQuality, "off">, depth: FrameGraphTextureHandle,
    width: number, height: number, failure?: EffectCompileFailure,
  ) {
    const scene = graph.scene;
    this.scene = scene;
    const settings = SCREEN_SHADOW_LEVELS[level];
    const wrapper = customWrapper(scene, "Screen shadows", screenShadowsShader(scene.getEngine().isWebGPU),
      ["ssProjection", "ssInverseProjection", "ssSun", "ssMarch", "ssFade", "ssTexel", "ssCascadeEnds", "ssCascadeCaps"], ["depthSampler"], failure);
    this.output = graph.textureManager.createRenderTargetTexture("Screen shadows", {
      size: { width, height },
      sizeIsPercentage: false,
      options: {
        createMipMaps: false,
        samples: 1,
        types: [Constants.TEXTURETYPE_HALF_FLOAT],
        formats: [Constants.TEXTUREFORMAT_RG],
        useSRGBBuffers: [false],
      },
    });
    const inverse = new Matrix();
    const toSun = new Vector3();
    this.task = new ScreenShadowsTask(graph, wrapper, depth, (effect) => {
      const projection = camera.getProjectionMatrix();
      projection.invertToRef(inverse);
      effect.setMatrix("ssProjection", projection);
      effect.setMatrix("ssInverseProjection", inverse);
      const sun = hapticShadowedSun(scene);
      if (sun && camera.mode === Camera.PERSPECTIVE_CAMERA) {
        const direction = sun.computeTransformedInformation() ? sun.transformedDirection : sun.direction;
        Vector3.TransformNormalToRef(direction, camera.getViewMatrix(), toSun);
        toSun.normalize().scaleInPlace(-1);
        effect.setFloat4("ssSun", toSun.x, toSun.y, toSun.z, 1);
      } else effect.setFloat4("ssSun", 0, 0, 1, 0);
      const caps = sun ? screenShadowThicknessCaps(sun, camera) : null;
      const ends = caps?.ends ?? NO_CASCADES, reach = caps?.caps ?? NO_CASCADES;
      effect.setFloat4("ssCascadeEnds", ends[0], ends[1], ends[2], ends[3]);
      effect.setFloat4("ssCascadeCaps", reach[0], reach[1], reach[2], reach[3]);
      effect.setFloat4("ssMarch", settings.steps, settings.pixels, settings.length, 0);
      effect.setFloat4("ssFade", settings.fadeStart, settings.fadeEnd, height * Math.abs(projection.m[5]!), 0);
      effect.setFloat2("ssTexel", 1 / width, 1 / height);
    });
    this.task.targetTexture = this.output;
  }

  /** Lets the draws of `renderPassId` (an objects pass of this view) read the screen shadows. */
  registerPass(renderPassId: number): void {
    let registry = registries.get(this.scene);
    if (!registry) registries.set(this.scene, (registry = new Map()));
    const entry = { texture: new ThinTexture(null) };
    this.entries.set(renderPassId, entry);
    registry.set(renderPassId, entry);
  }

  /** Attaches the built target to the registered passes; after each build. */
  reconcile(graph: FrameGraph): void {
    const texture = graph.textureManager.getTextureFromHandle(this.output);
    if (!texture) throw new Error("Screen shadows target is not allocated.");
    for (const entry of this.entries.values())
      if (entry.texture.getInternalTexture() !== texture) entry.texture = new ThinTexture(texture);
  }

  dispose(): void {
    const registry = registries.get(this.scene);
    for (const [id, entry] of this.entries) {
      if (registry?.get(id) === entry) registry.delete(id);
      // Never dispose the wrapper: it borrows the graph's texture.
      entry.texture = new ThinTexture(null);
    }
    this.entries.clear();
    this.task.dispose();
  }

  whenDisposed(): Promise<void> {
    return this.task.whenDisposed();
  }
  whenReleased(): Promise<void> {
    return this.task.whenReleased();
  }
}
