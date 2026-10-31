import { Camera, Constants, Matrix, RawTexture, ThinTexture, Vector3, type Effect, type Scene } from "@babylonjs/core";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import type { ScreenShadowsQuality } from "@haptic/core";
import { syntax } from "./ambient-occlusion-shader";
import type { EffectCompileFailure } from "./effect-compile-failure";
import { hapticShadowedSun } from "./haptic-lights";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { customWrapper } from "./spatial-effects";

/**
 * Screen-Space Shadows: before the objects draw, a full-resolution pass marches from each pixel of the spatial geometry
 * pass's depth toward the shadowed sun and writes RG16F (R: the sun's lit share, G: the eye distance of the surface it
 * marched from). The light block reads it at its own pixel for a surface at that distance, so glass, water and anything
 * the geometry pass did not see in front keep the sun's map alone, and combines it with the cascades by min.
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
 * render height times the projection's y scale), `ssTexel`. Derivatives come first: WGSL takes them in uniform control flow.
 */
export function screenShadowsShader(wgsl: boolean): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, sample, loop, output, main } = syntax(wgsl);
  const lit = (eye: string) => output(`${v4}(1.0, ${eye}, 0.0, 1.0)`);
  const header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("depthSampler")}
${field(wgsl ? "mat4x4f" : "mat4", "ssProjection")}${field(wgsl ? "mat4x4f" : "mat4", "ssInverseProjection")}
${field(v4, "ssSun")}${field(v4, "ssMarch")}${field(v4, "ssFade")}${field(v2, "ssTexel")}
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
${decl(f, "thickness", "0.15 + 0.02 * depth")}
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
  ${decl(f, "scene", `abs(${sample("depthSampler", "at")}.r)`)}
  ${decl(f, "delta", "abs(q.z) - scene")}
  if (scene > 0.000001 && delta > bias && delta < thickness) {
    ${decl(f, "edge", "min(min(at.x, 1.0 - at.x), min(at.y, 1.0 - at.y))")}
    occlusion = max(occlusion, (1.0 - 0.5 * t / reach) * clamp(edge * 20.0, 0.0, 1.0));
  }
}
${decl(f, "fade", `1.0 - smoothstep(${u("ssFade")}.x, ${u("ssFade")}.y, eye)`)}
${output(`${v4}(1.0 - occlusion * fade, eye, 0.0, 1.0)`)}
`;
  return header + main(body);
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
      ["ssProjection", "ssInverseProjection", "ssSun", "ssMarch", "ssFade", "ssTexel"], ["depthSampler"], failure);
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
