/**
 * Per-Scene water state shared by every water surface: placeholder textures, the lighting water reads from the Scene
 * (`sceneWaterLighting`) and the per-frame binding data that caches it with the Scene's removal volumes.
 */
import { BaseTexture, Color3, Constants, DirectionalLight, HemisphericLight, Matrix, RawTexture, Texture, Vector3, Scene } from "@babylonjs/core";
import type { WaterDefinition } from "@haptic/core";
import { sceneHasWaterRemovals, sceneWaterRemovals, waterRemovalWorldRadius } from "./water-removal-mesh";
import { waterHazeConstants } from "./water-shader-defines";

/**
 * Per-channel absorption of `water` for `transmittanceSource` (`slateWaterAbsorb`) into `out` (r, g, b, and Opacity's
 * cap on the absorption path, where the slowest channel reaches 1 − Opacity), from Shallow Color in linear space:
 * channels it lacks absorb fastest (`absorbCoefficient`), normalized so the slowest channel absorbs over five Depth Color
 * Distances: clear shallows keep the bed's light in the colour the water keeps. A grey Shallow Color absorbs evenly.
 * Allocation-free.
 */
export function waterAbsorption(water: WaterDefinition, exact: boolean, out: Float64Array): Float64Array {
  const tint = water.shallowColor;
  gammaScratch.set(Math.max(0, tint[0]), Math.max(0, tint[1]), Math.max(0, tint[2])).toLinearSpaceToRef(linearScratch, exact);
  const r = linearScratch.r, g = linearScratch.g, b = linearScratch.b, top = Math.max(r, g, b);
  const k = absorbCoefficient;
  const kr = k(r, top), kg = k(g, top), kb = k(b, top), weight = Math.min(kr, kg, kb);
  out[0] = kr / weight; out[1] = kg / weight; out[2] = kb / weight;
  out[3] = -Math.log(Math.max(1 - water.opacity, 1e-6)) / Math.min(out[0]!, out[1]!, out[2]!);
  return out;
}

const placeholders = new WeakMap<Scene, RawTexture>();
/** Field for surfaces nothing meets: far from terrain, terrain unknown. Contacts that are off ignore it. */
export function placeholderField(scene: Scene): RawTexture {
  let texture = placeholders.get(scene);
  if (!texture) {
    texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 0]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    texture.name = "water-field-placeholder";
    placeholders.set(scene, texture);
    scene.onDisposeObservable.addOnce(() => { texture!.dispose(); placeholders.delete(scene); });
  }
  return texture;
}

const fftPlaceholders = new WeakMap<Scene, BaseTexture>();
/**
 * One zero texel of the FFT band's type for variants that sample the band while it is not ready (their gain is 0 then,
 * so it contributes nothing): a 2D array of one layer, which out-of-range layers clamp to. Allocated as a never-drawn
 * one-layer render target, as the band's own output is (resources start zeroed on WebGL2 and WebGPU).
 */
export function placeholderFft(scene: Scene): BaseTexture {
  let texture = fftPlaceholders.get(scene);
  if (!texture) {
    const engine = scene.getEngine();
    const target = engine.createRenderTargetTexture({ width: 1, height: 1, layers: 1 }, {
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE, format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: "Water FFT placeholder",
    });
    // The wrapper holds its own reference, so the texture and the render target release independently.
    target.texture!.incrementReferences();
    const placeholder = texture = new BaseTexture(engine, target.texture);
    placeholder.name = "water-fft-placeholder";
    fftPlaceholders.set(scene, placeholder);
    scene.onDisposeObservable.addOnce(() => { placeholder.dispose(); target.dispose(); fftPlaceholders.delete(scene); });
  }
  return texture;
}

/**
 * One scene's water lighting for a frame, rewritten in place: the scene contribution before each material's environment
 * strength and low-light floor, and the analytic sky Realistic water reflects without an environment or skybox.
 */
export type WaterLighting = {
  ambient: Float64Array;
  /** Toward the strongest directional light (x, y, z) and its intensity; a default direction at intensity 0 without one. */
  sun: Float64Array;
  sunColor: Float64Array;
  /**
   * Linear zenith and horizon of the analytic sky. Such a scene shows its background colour as the sky: overhead it is
   * that colour deepened and saturated a little (half the hemispheric sky light's colour where the scene has one), at
   * the horizon the background itself, or the fog colour with fog on. Both are converted to linear space as Babylon's
   * PBR fog converts its fog colour (`BindFogParameters` with `linearSpace`), so the far sea meets its own fog.
   */
  sky: Float64Array;
  horizon: Float64Array;
  /**
   * Uniform-only sun terms Realistic water would otherwise evaluate per fragment (`slateWaterSunShape`): the horizontal
   * direction toward the sun (x, z), how much a low sun warms the analytic horizon, and the share of sunlight that
   * enters the water (most of a low sun's light reflects off at grazing incidence).
   */
  sunShape: Float64Array;
  /** Sunlight through thin crests, before the water's own colour: strongest for a sun some way up, none at sunset. */
  subsurfaceLift: number;
  /** Glitter strength: how clearly the sun stands out against the sky light (slateWaterSky.w). */
  sunGlitter: number;
  /** A sky light the sun does not outshine (overcast, storm; slateWaterHorizon.w): Realistic water's body greys. */
  overcast: number;
  /** `waterHazeConstants` of the active camera's far plane (`slateWaterHaze`). */
  haze: Float64Array;
};

export const linearScratch = new Color3(), gammaScratch = new Color3(), absorbScratch = new Float64Array(4);
/**
 * A Shallow Color channel's relative absorption through clear water (see `WaterMaterialPlugin.absorption`): the optical
 * depth that leaves the channel at its share of the brightest, over a small common floor. A cyan Shallow Color thus
 * absorbs red many times faster than blue and green a few times faster, as clear sea water does, so shallows over sand
 * turn turquoise and deeper water blue rather than green.
 */
const absorbCoefficient = (channel: number, top: number) => top > 0 ? 0.2 - Math.log(Math.max(channel / top, 0.02)) : 1;
/**
 * The gentler absorption the light through thin crests sees (`slateWaterThrough`): Beer-Lambert's −ln of the linear
 * channel plus a constant that keeps the channels' ratios mild (the fastest at most `GLOW_RATIO_CAP` times the
 * slowest), so the crest glow takes Shallow Color's hue without turning neon.
 */
export const glowCoefficient = (channel: number) => 0.6 - Math.log(Math.max(channel, 1e-3));
export const GLOW_RATIO_CAP = 5;

function sceneWaterLighting(scene: Scene, out: WaterLighting): void {
  let ar = 0, ag = 0, ab = 0, hr = 0, hg = 0, hb = 0, hemispheres = 0;
  let sun: DirectionalLight | null = null;
  for (const light of scene.lights) {
    if (!light.isEnabled() || light.intensity <= 0) continue;
    if (light instanceof HemisphericLight) {
      const i = light.intensity, d = light.diffuse, g = light.groundColor;
      ar += d.r * i * 0.6 + g.r * i * 0.2; ag += d.g * i * 0.6 + g.g * i * 0.2; ab += d.b * i * 0.6 + g.b * i * 0.2;
      hr += d.r * i; hg += d.g * i; hb += d.b * i; hemispheres++;
    } else if (light instanceof DirectionalLight) {
      if (!sun || light.intensity > sun.intensity) sun = light;
    }
  }
  const { sun: toSun, sunColor, ambient, sky, horizon } = out;
  if (sun) {
    const d = sun.direction, length = Math.hypot(d.x, d.y, d.z) || 1, up = Math.max(0, -d.y / length) * sun.intensity * 0.55;
    toSun[0] = -d.x / length; toSun[1] = -d.y / length; toSun[2] = -d.z / length; toSun[3] = sun.intensity;
    sunColor[0] = sun.diffuse.r; sunColor[1] = sun.diffuse.g; sunColor[2] = sun.diffuse.b;
    ar += sun.diffuse.r * up; ag += sun.diffuse.g * up; ab += sun.diffuse.b * up;
  } else {
    toSun[0] = -0.4; toSun[1] = 0.8; toSun[2] = 0.45; toSun[3] = 0;
    sunColor[0] = sunColor[1] = sunColor[2] = 1;
  }
  ambient[0] = ar; ambient[1] = ag; ambient[2] = ab;
  // Linear space as Babylon converts colours (exact sRGB where the engine uses it), so the reflected horizon matches
  // the fog the water itself fades into. Light colours above are linear already: Babylon's PBR lights shade with them
  // unconverted.
  const exact = scene.getEngine().useExactSrgbConversions, clear = scene.clearColor;
  gammaScratch.set(Math.max(0, clear.r), Math.max(0, clear.g), Math.max(0, clear.b)).toLinearSpaceToRef(linearScratch, exact);
  const cr = linearScratch.r, cg = linearScratch.g, cb = linearScratch.b;
  const luminance = Math.max(0.3 * cr + 0.59 * cg + 0.11 * cb, 1e-4);
  // A hemispheric light is the scene's sky light, a better guide to the sky drawn behind the water (a dome, a grey
  // storm) than the clear colour: the sky takes mostly its colour.
  // A sky light is brighter than the sky it stands for (it also carries bounce and fill): the reflected sky takes about
  // half of it, a little more at the horizon than overhead, so a grey storm's far sea stays as grey as its sky.
  const lit = hemispheres > 0 ? 0.92 : 0, hemi = 0.45, hemiHorizon = 0.55;
  sky[0] = (0.65 * cr + 0.35 * cr * cr / luminance) * 0.85 * (1 - lit) + hr * hemi * lit;
  sky[1] = (0.65 * cg + 0.35 * cg * cg / luminance) * 0.85 * (1 - lit) + hg * hemi * lit;
  sky[2] = (0.65 * cb + 0.35 * cb * cb / luminance) * 0.85 * (1 - lit) + hb * hemi * lit;
  const fog = scene.fogEnabled && scene.fogMode !== Scene.FOGMODE_NONE;
  if (fog) scene.fogColor.toLinearSpaceToRef(linearScratch, exact);
  // Without fog the horizon is the background, shared like the zenith with a hemispheric light's sky colour.
  horizon[0] = fog ? linearScratch.r : cr * (1 - lit) + hr * hemiHorizon * lit;
  horizon[1] = fog ? linearScratch.g : cg * (1 - lit) + hg * hemiHorizon * lit;
  horizon[2] = fog ? linearScratch.b : cb * (1 - lit) + hb * hemiHorizon * lit;
  const shape = out.sunShape, horizontal = Math.hypot(toSun[0]!, toSun[2]!), up = toSun[1]!;
  shape[0] = horizontal > 1e-4 ? toSun[0]! / horizontal : 0;
  shape[1] = horizontal > 1e-4 ? toSun[2]! / horizontal : 0;
  shape[2] = (1 - smoothstep(0, 0.5, up)) * smoothstep(-0.1, 0.02, up);
  shape[3] = 0.25 + 0.75 * smoothstep(0, 0.5, up);
  // A high sun lights crests from above rather than through them; a setting sun's light is dim and red, which the water
  // absorbs, so the glow is gone by the time the sun nears the horizon.
  out.subsurfaceLift = smoothstep(0.06, 0.2, up) * (1 - 0.6 * smoothstep(0.3, 0.8, up));
  // How clearly the sun stands out against the sky light (the hemispheric light where there is one, which a high sun
  // does not inflate): under an overcast or stormy sky, where the sun is no brighter than the sky, its glitter is gone
  // and Realistic water greys with the sky.
  const skyLight = hemispheres > 0 ? 0.3 * hr + 0.59 * hg + 0.11 * hb : 0.3 * ambient[0]! + 0.59 * ambient[1]! + 0.11 * ambient[2]!;
  out.sunGlitter = smoothstep(1.05, 1.5, toSun[3]! / Math.max(skyLight, 0.05));
  out.overcast = hemispheres > 0 ? 1 - out.sunGlitter : 0;
  waterHazeConstants(scene.activeCamera?.maxZ ?? 0, out.haze);
}

/** Each material's ambient: the scene's, plus its environment's share and a low-light floor. Writes `waterAmbient`. */
const waterAmbient = new Float64Array(3);
/**
 * How strongly the scene lights a water body's own colour (Deep Color and its subsurface light), from the ambient light
 * the water sees (`withWaterEnvironment`) and the sun: a dim scene keeps a dim sea. 0.05 to 1.6.
 */
export function waterBodyLight(ambient: ArrayLike<number>, light: Pick<WaterLighting, "sun" | "sunColor">): number {
  const luminance = (r: number, g: number, b: number) => r * 0.3 + g * 0.59 + b * 0.11;
  const sun = light.sun, color = light.sunColor;
  const lit = luminance(ambient[0]!, ambient[1]!, ambient[2]!) * 1.4 + luminance(color[0]!, color[1]!, color[2]!) * sun[3]! * Math.max(sun[1]!, 0) * 0.35;
  return Math.min(1.6, Math.max(0.05, lit));
}

/**
 * `waterBodyLight` of `water` in `scene` this frame, as built-in water lights its colour (`slateWaterLight.w`), for a
 * Custom Material's Water Colors node. `reflective`: the water reflects an environment or skybox cube.
 */
export function sceneWaterBodyLight(scene: Scene, water: WaterDefinition, reflective: boolean): number {
  const lighting = sceneWaterBindingData(scene).lighting;
  return waterBodyLight(withWaterEnvironment(lighting, water.reflectionStrength, reflective), lighting);
}

export function withWaterEnvironment(light: WaterLighting, environmentStrength: number, reflective: boolean): Float64Array {
  const out = waterAmbient, extra = reflective ? 0.45 * environmentStrength : 0;
  out[0] = light.ambient[0]! + 0.8 * extra; out[1] = light.ambient[1]! + 0.9 * extra; out[2] = light.ambient[2]! + extra;
  if (out[0] + out[1] + out[2] < 0.25) { out[0] = Math.max(out[0], 0.08); out[1] = Math.max(out[1], 0.08); out[2] = Math.max(out[2], 0.08); }
  return out;
}

export type WaterRemovalCandidate = ReturnType<typeof sceneWaterRemovals>[number] & {
  position: Vector3;
  radius: number;
  inverse?: Matrix;
  /** `waterRemovalShapeVector` of the volume, filled at its first bind this render. */
  shape?: [number, number, number, number];
};
export type WaterBindingData = {
  frame: number;
  render: number;
  lighting: WaterLighting;
  removals: WaterRemovalCandidate[];
};
const waterBindings = new WeakMap<Scene, WaterBindingData>();

const NO_REMOVALS: WaterRemovalCandidate[] = [];

/**
 * Lazy so animations and before-render updates settle before the first water draw. Rewritten in place once per
 * render; a scene without removal volumes allocates nothing.
 */
/**
 * The scene's water lighting this render (`sceneWaterLighting`): the sun, ambient and the analytic sky and horizon the
 * water nodes reflect without an environment. Shared with built-in water; read-only.
 */
export function sceneWaterNodeLighting(scene: Scene): Readonly<Pick<WaterLighting, "sun" | "sunColor" | "sky" | "horizon" | "sunShape">> {
  return sceneWaterBindingData(scene).lighting;
}

export function sceneWaterBindingData(scene: Scene): WaterBindingData {
  let data = waterBindings.get(scene);
  const frame = scene.getFrameId(), render = scene.getRenderId();
  if (data?.frame === frame && data.render === render) return data;
  if (!data) {
    data = {
      frame, render, removals: NO_REMOVALS,
      lighting: {
        ambient: new Float64Array(3), sun: new Float64Array(4), sunColor: new Float64Array(3), sky: new Float64Array(3), horizon: new Float64Array(3),
        sunShape: new Float64Array(4), subsurfaceLift: 0, sunGlitter: 0, overcast: 0, haze: new Float64Array(4),
      },
    };
    waterBindings.set(scene, data);
    scene.onDisposeObservable.addOnce(() => waterBindings.delete(scene));
  }
  data.frame = frame; data.render = render;
  sceneWaterLighting(scene, data.lighting);
  data.removals = sceneHasWaterRemovals(scene) ? sceneWaterRemovals(scene).map((entry) => {
    entry.mesh.computeWorldMatrix(true);
    return { ...entry, position: entry.mesh.getAbsolutePosition().clone(), radius: waterRemovalWorldRadius(entry.mesh, entry.volume) };
  }) : NO_REMOVALS;
  return data;
}

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
