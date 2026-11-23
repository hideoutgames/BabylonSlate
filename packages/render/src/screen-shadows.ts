import { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphPostProcessTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask";
import type { ScreenShadowsQuality } from "@haptic/core";
import type { EffectCompileFailure } from "./effect-compile-failure";
import { hapticShadowedSun } from "./haptic-lights";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { AtlasCascadedShadowGenerator, shadowTileSize } from "./shadow-atlas";
import { SHADOW_FILTER_REACH_TEXELS } from "./shadow-filter";
import { sceneRenderingSettings } from "./render-settings";
import { customWrapper, SCREEN_SHADOW_SCALE } from "./spatial-effects";

/**
 * Screen-Space Shadows: before the objects draw, a half-resolution pass (`SCREEN_SHADOW_SCALE`) marches once per 2 x 2
 * block of the spatial geometry pass's depth, from the block's farthest surface pixel, toward the shadowed sun and writes
 * RGBA16F: the lit share, that pixel's eye distance, which of the block's pixels share its surface and the distance of
 * one that does not (`screenShadowsShader`). Only pixels the geometry pass marks as a shadow caster's (its depth's G
 * channel, `meshCastsShadows`) occlude, so Cast Shadows holds for the march as for the map. The light block knows the
 * surface at its own pixel from that, as at full resolution, so glass, water and anything the geometry pass did not see
 * in front keep the sun's map alone, and blends the texels within two pixels that marched from its surface, so a contact
 * shadow's edge stays on the geometry's edge. It combines the result with the cascades by min, on receivers only.
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
 * The march, one texel per 2 x 2 block of render pixels. Uniforms: `ssProjection`, `ssInverseProjection` (the camera's
 * projection, which the geometry pass drew with), `ssSun` (the view-space direction toward the sun; w 0 writes lit: no
 * shadowed sun, an orthographic view), `ssMarch` (steps, pixel cap, world cap; w unused), `ssFade` (fade start and
 * end, the render height times the projection's y scale: the pixel cap and the start offset stay in render pixels),
 * `ssTexel` (one march texel, the dither's grid), `ssCascadeEnds` and `ssCascadeCaps` (`screenShadowThicknessCaps`; an
 * unused cascade ends at -1).
 *
 * It marches from the block's farthest surface pixel (a receiver, where a block straddles a caster's edge) and writes
 * RGBA16F: R the lit share, G that pixel's eye distance, B which of the block's pixels lie on its surface (bits 0-3, by
 * `x + 2 y`) plus 16 times its index and 64 times the index of the first pixel off it, A that pixel's eye distance (0
 * with none). The light block then knows the surface at its own pixel (`hapticScreenShadowLit`), as at full resolution.
 */
function screenShadowsShader(): string {
  const early = (value: string) => `gl_FragColor = ${value}; return;`;
  const last = (value: string) => `gl_FragColor = ${value};`;
  const header = `varying vec2 vUV;
uniform sampler2D depthSampler;
uniform mat4 ssProjection;
uniform mat4 ssInverseProjection;
uniform vec4 ssSun;
uniform vec4 ssMarch;
uniform vec4 ssFade;
uniform vec2 ssTexel;
uniform vec4 ssCascadeEnds;
uniform vec4 ssCascadeCaps;
`;
  const functions = `// The view-space point the depth texel at \`pixel\` shows (on the ray through its centre), and that depth.
vec3 ssPoint(ivec2 pixel, ivec2 size, out float depth) {
  pixel = clamp(pixel, ivec2(0), size - ivec2(1));
  depth = abs(texelFetch(depthSampler, pixel, 0).r);
  vec4 unprojected = ssInverseProjection * vec4((vec2(pixel) + 0.5) / vec2(size) * 2.0 - 1.0, 0.5, 1.0);
  vec3 ray = unprojected.xyz / unprojected.w;
  return ray * (depth / max(abs(ray.z), 0.000001));
}
`;
  const body = `  ivec2 size = textureSize(depthSampler, 0);
  ivec2 corner = ivec2(gl_FragCoord.xy) * ${SCREEN_SHADOW_SCALE};
  vec3 points[4];
  float depths[4];
  int marched = -1;
  float farthest = -1.0;
  for (int i = 0; i < 4; i++) {
    points[i] = ssPoint(corner + ivec2(i % 2, i / 2), size, depths[i]);
    float eye = depths[i] > 0.000001 ? length(points[i]) : -1.0;
    if (eye > farthest) { farthest = eye; marched = i; }
  }
  if (marched < 0) { ${early("vec4(1.0, 0.0, 0.0, 0.0)")} }
  vec3 P = points[marched];
  float depth = depths[marched];
  float eye = length(P);
  ivec2 origin = corner + ivec2(marched % 2, marched / 2);
  // The surface's plane from the depth two pixels to each side, each axis toward the side nearer in depth (the same
  // face); one pixel's difference of a coarse depth is noisy.
  float leftDepth, rightDepth, downDepth, upDepth;
  vec3 left = ssPoint(origin - ivec2(2, 0), size, leftDepth), right = ssPoint(origin + ivec2(2, 0), size, rightDepth);
  vec3 down = ssPoint(origin - ivec2(0, 2), size, downDepth), up = ssPoint(origin + ivec2(0, 2), size, upDepth);
  vec3 dx = abs(rightDepth - depth) < abs(leftDepth - depth) ? right - P : P - left;
  vec3 dy = abs(upDepth - depth) < abs(downDepth - depth) ? up - P : P - down;
  vec3 N = cross(dx, dy);
  bool planeless = dot(N, N) < 1e-12;
  N = planeless ? vec3(0.0) : normalize(N);
  if (dot(N, P) > 0.0) { N = -N; }
  // Which of the block's pixels lie on the marched surface's plane, and the first that does not.
  float tolerance = 0.004 * depth + 0.01;
  float mask = 0.0;
  int other = marched;
  float otherEye = 0.0;
  for (int i = 0; i < 4; i++) {
    bool valid = depths[i] > 0.000001;
    bool on = valid && (i == marched || (!planeless && abs(dot(points[i] - P, N)) < tolerance));
    if (on) mask += exp2(float(i));
    else if (valid && otherEye == 0.0) { other = i; otherEye = length(points[i]); }
  }
  float info = mask + 16.0 * float(marched) + 64.0 * float(other);
  if (ssSun.w < 0.5 || planeless || eye >= ssFade.y) { ${early("vec4(1.0, eye, info, otherEye)")} }
  vec3 L = ssSun.xyz;
  float NdotL = dot(N, L);
  if (NdotL <= 0.0) { ${early("vec4(1.0, eye, info, otherEye)")} }
  float footprint = 2.0 * depth / ssFade.z;
  float reach = min(ssMarch.z, ssMarch.y * footprint);
  float bias = (0.004 * depth + 0.01) / max(NdotL, 0.25);
  // The deepest a surface the ray passes behind is taken to be: 0.15 m + 0.02 z, at most the bias plus the reach of the
  // cascade filtering this depth (none beyond the last), and at least the bias plus the ray's depth change over a step.
  vec4 ends = ssCascadeEnds;
  vec4 caps = ssCascadeCaps;
  float cap = 1.0e4;
  if (depth <= ends.w) { cap = caps.w; }
  if (depth <= ends.z) { cap = caps.z; }
  if (depth <= ends.y) { cap = caps.y; }
  if (depth <= ends.x) { cap = caps.x; }
  float stepDepth = abs(L.z) * reach / ssMarch.x;
  float thickness = min(0.15 + 0.02 * depth, bias + max(stepDepth, cap));
  vec3 start = P + L * (1.5 * footprint);
  vec2 pixel = floor(vUV / ssTexel);
  float dither = fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
  float occlusion = 0.0;
  for (int i = 0; i < ${MAX_STEPS}; i++) {
    if (float(i) >= ssMarch.x) { break; }
    float t = (float(i) + dither) / ssMarch.x * reach;
    vec3 q = start + L * t;
    vec4 clip = ssProjection * vec4(q, 1.0);
    if (clip.w <= 0.0) { break; }
    vec2 at = clip.xy / clip.w * 0.5 + 0.5;
    if (at.x < 0.0 || at.y < 0.0 || at.x > 1.0 || at.y > 1.0) { break; }
    vec2 stored = texture2D(depthSampler, at).rg;
    float scene = abs(stored.x);
    float delta = abs(q.z) - scene;
    // Only a shadow caster's pixel occludes (the geometry pass's caster mark, G).
    if (stored.y > 0.5 && scene > 0.000001 && delta > bias && delta < thickness) {
      float edge = min(min(at.x, 1.0 - at.x), min(at.y, 1.0 - at.y));
      occlusion = max(occlusion, (1.0 - 0.5 * t / reach) * clamp(edge * 20.0, 0.0, 1.0));
    }
  }
  float fade = 1.0 - smoothstep(ssFade.x, ssFade.y, eye);
  ${last("vec4(1.0 - occlusion * fade, eye, info, otherEye)")}
`;
  return `${header}${functions}void main() {
${body}}
`;
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

/** An objects pass's screen shadows: read only while the view's march runs (`ScreenShadowsGraph.sync`). */
type PassEntry = { texture: ThinTexture; marching: boolean };
const registries = new WeakMap<Scene, Map<number, PassEntry>>();
const placeholders = new WeakMap<Scene, ThinTexture>();

/**
 * The screen shadows the draw of `renderPassId` reads, or null: any pass but a planned view's objects passes, and those
 * while the view's march is idle (its target then holds an earlier frame's).
 */
export function screenShadowsForPass(scene: Scene, renderPassId: number): ThinTexture | null {
  const entry = registries.get(scene)?.get(renderPassId);
  return entry?.marching && entry.texture.getInternalTexture() ? entry.texture : null;
}

/** A lit 1 × 1 texture every program declaring the screen shadows binds where its pass has none. */
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
  /** The geometry buffers it samples, nearest, by sampler name. */
  private readonly buffers: Record<string, FrameGraphTextureHandle>;
  private readonly bind: (effect: Effect) => void;
  constructor(graph: FrameGraph, wrapper: ReturnType<typeof customWrapper>, buffers: Record<string, FrameGraphTextureHandle>,
    bind: (effect: Effect) => void) {
    super(wrapper.name, graph, wrapper);
    this.buffers = buffers;
    this.bind = bind;
    this.depthTest = false;
  }
  override record() {
    const pass = super.record(true, undefined, (context) => {
      const effect = this.drawWrapper.effect!;
      for (const [name, handle] of Object.entries(this.buffers)) {
        context.setTextureSamplingMode(handle, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
        context.bindTextureHandle(effect, name, handle);
      }
      this.bind(effect);
    });
    pass.addDependencies(Object.values(this.buffers));
    pass.setRenderTarget(this.outputTexture);
    // Idle (`ScreenShadowsGraph.sync`): Babylon runs the enabled passes of a disabled task that has no disabled pass.
    const idle = this._frameGraph.addRenderPass(`${this.name}_disabled`, true);
    idle.setRenderTarget(this.outputTexture);
    idle.setExecuteFunc(() => {});
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
 * One view's screen shadows: the task (after the geometry pass, before the objects), its RGBA16F target and the objects
 * passes that read it. With no shadowed sun or an orthographic camera the march would write lit everywhere, so it idles
 * (`sync`, each frame): the task draws nothing and the objects bind the placeholder with the read off, which the light
 * block takes as lit, as it would the march's 1. The sun starting to cast shadows creates no pipeline, only re-enables
 * the task. Nor does a level change: every level is the same program and target, so the march reads the Scene's current
 * level (`level` until its plan has one) when it draws.
 */
export class ScreenShadowsGraph {
  readonly task: ScreenShadowsTask;
  readonly output: FrameGraphTextureHandle;
  private readonly entries = new Map<number, PassEntry>();
  private readonly scene: Scene;
  private readonly camera: Camera;
  private marching = true;

  constructor(
    graph: FrameGraph, camera: Camera, level: Exclude<ScreenShadowsQuality, "off">, depth: FrameGraphTextureHandle,
    width: number, height: number, failure?: EffectCompileFailure,
  ) {
    const scene = graph.scene;
    this.scene = scene;
    this.camera = camera;
    const wrapper = customWrapper(scene, "Screen shadows", screenShadowsShader(),
      ["ssProjection", "ssInverseProjection", "ssSun", "ssMarch", "ssFade", "ssTexel", "ssCascadeEnds", "ssCascadeCaps"], ["depthSampler"], failure);
    const marchWidth = Math.ceil(width / SCREEN_SHADOW_SCALE), marchHeight = Math.ceil(height / SCREEN_SHADOW_SCALE);
    this.output = graph.textureManager.createRenderTargetTexture("Screen shadows", {
      size: { width: marchWidth, height: marchHeight },
      sizeIsPercentage: false,
      options: {
        createMipMaps: false,
        samples: 1,
        types: [Constants.TEXTURETYPE_HALF_FLOAT],
        formats: [Constants.TEXTUREFORMAT_RGBA],
        useSRGBBuffers: [false],
      },
    });
    const inverse = new Matrix();
    const toSun = new Vector3();
    this.task = new ScreenShadowsTask(graph, wrapper, { depthSampler: depth }, (effect) => {
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
      const settings = SCREEN_SHADOW_LEVELS[sceneRenderingSettings(scene).effectsPlan?.screenShadows ?? level];
      effect.setFloat4("ssMarch", settings.steps, settings.pixels, settings.length, 0);
      effect.setFloat4("ssFade", settings.fadeStart, settings.fadeEnd, height * Math.abs(projection.m[5]!), 0);
      effect.setFloat2("ssTexel", 1 / marchWidth, 1 / marchHeight);
    });
    this.task.targetTexture = this.output;
  }

  /** Lets the draws of `renderPassId` (an objects pass of this view) read the screen shadows. */
  registerPass(renderPassId: number): void {
    let registry = registries.get(this.scene);
    if (!registry) registries.set(this.scene, (registry = new Map()));
    const entry = { texture: new ThinTexture(null), marching: this.marching };
    this.entries.set(renderPassId, entry);
    registry.set(renderPassId, entry);
  }

  /**
   * Whether the pass runs this frame: the march runs with a shadowed sun (the light block's, written before the frame)
   * and a perspective camera, and turns its readers off otherwise. Before each frame's graph execution; idles the task
   * while it does not march.
   */
  sync(): boolean {
    this.marching = hapticShadowedSun(this.scene) !== null && this.camera.mode === Camera.PERSPECTIVE_CAMERA;
    this.task.disabled = !this.marching;
    for (const entry of this.entries.values()) entry.marching = this.marching;
    return this.marching;
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
