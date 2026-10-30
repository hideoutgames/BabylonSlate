/**
 * Test-build-only proof of the lighting plan's HapticLightingBlock on the real GPU, through the Forward FrameGraph:
 * graph Materials drawn with the block against expectations derived here from the block's model rather than from
 * another renderer (its BRDF evaluated per pixel for the punctual lights, mirrors and white metals in cubes of known
 * colours, rect lights' form factors and mirror images), its CEL define, its Effects across light changes in both
 * render modes, and its shadows against ray-cast occlusion masks.
 */
import {
  Color4,
  Constants,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  Matrix,
  MeshBuilder,
  PointLight,
  RawCubeTexture,
  Ray,
  Scene,
  ShadowGenerator,
  SpotLight,
  TransformNode,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Effect,
  type Light,
  type NodeMaterial,
} from "@babylonjs/core";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import {
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
  type CelShadingSettings,
  type RenderMode,
} from "@haptic/core";
import {
  applyAuthoredLightProperties,
  compileMaterialPlan,
  createAppWebGpuEngine,
  setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import type { AreaEmissionPixels } from "@haptic/assets";
import { setRectLightEmission } from "../../../../packages/render/src/area-emission-array";
import { retainAreaLightLookup } from "../../../../packages/render/src/area-light-resources";
import { OwnedRectAreaLight } from "../../../../packages/render/src/area-rect-light";
import { retainFilteredEnvironment } from "../../../../packages/render/src/environment-prefilter";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { isAtlasShadow } from "../../../../packages/render/src/shadow-atlas";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Surface = { name: string; baseColor: readonly number[]; metallic: number; specular: number; roughness: number; environmentInfluence: number };
const SURFACES: Surface[] = [
  { name: "rough dielectric", baseColor: [0.8, 0.8, 0.8], metallic: 0, specular: 0.5, roughness: 0.6, environmentInfluence: 1 },
  { name: "smooth metal", baseColor: [0.95, 0.75, 0.35], metallic: 1, specular: 0.5, roughness: 0.25, environmentInfluence: 1 },
  // Water's Specular.
  { name: "glossy dielectric", baseColor: [0.2, 0.35, 0.8], metallic: 0, specular: 0.255, roughness: 0.15, environmentInfluence: 0.5 },
];
const WHITE_METAL: Surface = { name: "white metal", baseColor: [1, 1, 1], metallic: 1, specular: 0.5, roughness: 0.4, environmentInfluence: 1 };
/**
 * A non-metal that reflects nothing at normal incidence (Specular 0, so F0 = 0): its direct light needs no
 * environment BRDF table (the multi-scatter energy term is one), so the oracle below evaluates it exactly.
 */
const MATTE: Surface = { name: "matte", baseColor: [0.8, 0.8, 0.8], metallic: 0, specular: 0, roughness: 0.6, environmentInfluence: 1 };
/** MATTE without its diffuse colour: the two differ by the diffuse light alone, their specular being the same. */
const BLACK: Surface = { ...MATTE, name: "black", baseColor: [0, 0, 0] };
/**
 * A Material's base colour is authored in display space and lit decoded: Babylon's 2.2 power, or the exact sRGB curve on
 * an Engine with exact conversions (the app's WebGPU Engine).
 */
const linearBase = (surface: Surface, exact: boolean) => surface.baseColor.map((channel) =>
  !exact ? channel ** 2.2 : channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
/** A white metal at the smoothest roughness: F0 = 1, so environment and rect light reflections arrive unscaled. */
const MIRROR: Surface = { name: "mirror", baseColor: [1, 1, 1], metallic: 1, specular: 0.5, roughness: 0, environmentInfluence: 1 };

/** A prepared emission's texel: warm to cool across, light to dark down, as Prepare Emission's 1024 square. */
function emissionTexel(x: number, y: number, edge: number): [number, number, number] {
  const across = x / edge;
  const down = 0.4 + 0.6 * (1 - y / edge);
  return [255 * down * (1 - 0.6 * across), 255 * down * 0.8, 255 * down * (0.4 + 0.6 * across)];
}
function emissionPixels(name: string, texel: (x: number, y: number, edge: number) => [number, number, number]): AreaEmissionPixels {
  const edge = 1024;
  const rgba = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) for (let x = 0; x < edge; x++) rgba.set([...texel(x, y, edge), 255], (y * edge + x) * 4);
  return { metadata: { processor: "haptic-light-proof", pixelsHash: name, width: edge, height: edge }, rgba } as unknown as AreaEmissionPixels;
}

/** A cube face's pixels: a sky gradient from a bright zenith to a dark ground, tinted per face. */
function skyFace(index: number, size: number): Uint8Array {
  const tint = [[1, 0.9, 0.8], [0.8, 0.9, 1], [1, 1, 1], [0.3, 0.25, 0.2], [0.9, 1, 0.85], [1, 0.85, 0.9]][index]!;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const t = index === 2 ? 1 : index === 3 ? 0.2 : 1 - y / size;
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(255 * (0.15 + 0.7 * t) * tint[channel]!);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
/** One flat colour per face (+X, -X, +Y, -Y, +Z, -Z), so a reflected direction names the colour it shows. */
const FACE_COLORS = [[200, 60, 60], [60, 180, 70], [70, 90, 210], [190, 170, 50], [170, 60, 180], [50, 170, 170]] as const;
/** The furnace cube: one grey on every face. */
const UNIFORM_GREY = 128;
const flatFace = (color: readonly number[], size: number) => {
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index++) pixels.set([color[0]!, color[1]!, color[2]!, 255], index * 4);
  return pixels;
};

function litEffectKeys(engine: AbstractEngine): string[] {
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  return Object.keys(effects).filter((key) => effects[key]!.fragmentSourceCode.includes("HapticLights")).sort();
}

// The block's model (haptic-lighting-shader.ts), restated: GGX with its alpha floor, height-correlated Smith,
// Schlick's Fresnel, Lambert, the saturated N.L and the absolute N.V.
const EPSILON = 1e-7;
const saturateEps = (value: number) => Math.min(Math.max(value, EPSILON), 1);
type Rgb = [number, number, number];
function specular(F0: number, N: Vector3, V: Vector3, L: Vector3, NdotL: number, NdotV: number, roughness: number): number {
  const H = V.add(L).normalize();
  const VdotH = Math.min(Math.max(Vector3.Dot(V, H), 0), 1);
  const NdotH = saturateEps(Vector3.Dot(N, H));
  const alpha = roughness * roughness + 0.0005;
  const a2 = alpha * alpha;
  const d = NdotH * NdotH * (a2 - 1) + 1;
  const distribution = a2 / (Math.PI * d * d);
  const ggxV = NdotL * Math.sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
  const ggxL = NdotV * Math.sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
  const fresnel = F0 + (1 - F0) * (1 - VdotH) ** 5;
  return fresnel * distribution * (0.5 / (ggxV + ggxL)) * NdotL;
}
const lightColor = (light: Light): Rgb => {
  const intensity = light.getScaledIntensity();
  return [light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity];
};
/**
 * The linear colour the block draws at P (normal N, seen from `eye`) for a non-metal with F0 = 0 (MATTE), lit by the
 * enabled punctual lights and the fill, without environment: per light its colour times intensity, the inverse-square
 * falloff windowed to zero at the range and a spot's glTF cone (full inside its inner angle, zero past its outer, the
 * cosine's linear step squared between); the fill mixes ground to sky by the wrapped N.L.
 */
function directLight(P: Vector3, N: Vector3, eye: Vector3, baseColor: readonly number[], roughness: number, lights: Light[]): Rgb {
  const V = eye.subtract(P).normalize();
  const NdotV = Math.abs(Vector3.Dot(N, V)) + EPSILON;
  const diffuse: Rgb = [0, 0, 0];
  const glossy: Rgb = [0, 0, 0];
  const add = (target: Rgb, color: Rgb, scale: number) => { for (let c = 0; c < 3; c++) target[c] += color[c]! * scale; };
  for (const light of lights) {
    if (!light.isEnabled()) continue;
    if (light instanceof HemisphericLight) {
      const L = light.direction.normalizeToNew();
      const NdotL = saturateEps(Vector3.Dot(N, L) * 0.5 + 0.5);
      const sky = lightColor(light);
      const ground = light.groundColor.scale(light.intensity);
      add(diffuse, [ground.r + (sky[0] - ground.r) * NdotL, ground.g + (sky[1] - ground.g) * NdotL, ground.b + (sky[2] - ground.b) * NdotL], 1);
      add(glossy, sky, specular(0, N, V, L, NdotL, NdotV, roughness));
    } else if (light instanceof DirectionalLight) {
      const L = light.direction.scale(-1).normalize();
      const NdotL = saturateEps(Vector3.Dot(N, L));
      add(diffuse, lightColor(light), NdotL / Math.PI);
      add(glossy, lightColor(light), specular(0, N, V, L, NdotL, NdotV, roughness));
    } else if (light instanceof SpotLight || light instanceof PointLight) {
      const offset = light.position.subtract(P);
      const distanceSquared = offset.lengthSquared();
      if (distanceSquared >= light.range * light.range) continue;
      const distance = Math.sqrt(distanceSquared);
      const L = offset.scale(1 / distance);
      const NdotL = saturateEps(Vector3.Dot(N, L));
      const ratio = distanceSquared / (light.range * light.range);
      const window = Math.min(Math.max(1 - ratio * ratio, 0), 1);
      let falloff = window * window / distanceSquared;
      if (light instanceof SpotLight) {
        const cosOuter = Math.cos(light.angle / 2);
        const scale = 1 / Math.max(0.001, Math.cos(light.innerAngle / 2) - cosOuter);
        const cone = Math.min(Math.max((-Vector3.Dot(L, light.direction.normalizeToNew()) - cosOuter) * scale, 0), 1);
        falloff *= cone * cone;
      }
      const radiance = lightColor(light).map((value) => value * falloff) as Rgb;
      add(diffuse, radiance, NdotL / Math.PI);
      add(glossy, radiance, specular(0, N, V, L, NdotL, NdotV, Math.min(light.radius / distance + roughness, 1)));
    }
  }
  return [0, 1, 2].map((c) => baseColor[c]! * diffuse[c]! + Math.max(glossy[c]!, 0)) as Rgb;
}

/**
 * A Lambertian receiver's irradiance from a rect of unit radiance, as the block's LTC evaluates it with the identity
 * transform: the polygon's vector form factor F (each edge's angle times its normalised cross product, over 2π), then
 * the sphere approximation of horizon clipping ((|F|² + Fz) / (|F| + 1)); zero behind the emitting side. Corners in the
 * block's order: centre + width - height, - width - height, - width + height, + width + height. The LTC frame is
 * Babylon's left-handed one (T1, -N × T1, N), so Fz is F against -N in world space.
 */
function rectFormFactor(P: Vector3, N: Vector3, corners: Vector3[]): number {
  const [c0, c1, , c3] = corners as [Vector3, Vector3, Vector3, Vector3];
  if (Vector3.Dot(Vector3.Cross(c1.subtract(c0), c3.subtract(c0)), P.subtract(c0)) < 0) return 0;
  const directions = corners.map((corner) => corner.subtract(P).normalize());
  const form = Vector3.Zero();
  for (let index = 0; index < 4; index++) {
    const a = directions[index]!;
    const b = directions[(index + 1) % 4]!;
    const cross = Vector3.Cross(a, b);
    const sine = cross.length();
    if (sine < 1e-9) continue;
    form.addInPlace(cross.scale(Math.atan2(sine, Vector3.Dot(a, b)) / sine));
  }
  form.scaleInPlace(1 / (2 * Math.PI));
  const length = form.length();
  return Math.max((length * length - Vector3.Dot(form, N)) / (length + 1), 0);
}

export async function runHapticLightProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 80;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  const releases: (() => void)[] = [];
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 3.6, -7), scene);
    camera.setTarget(new Vector3(0, 0.5, 0));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    // As Play's world Scene: Babylon's light helpers ask the fixed-shape hooks first.
    setFixedShapeLightingWorldScene(scene);
    setSceneBindsPreviousEffects(scene);
    const quality = normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } });
    // One local shadow and the sun's two cascades, which only the shadow poses cast, biased past the acne a slanting
    // light would show on the floor.
    const shadows = normalizeShadowSettings({ cascades: 2, maxLocalLights: 1, depthBias: 0.0008 });
    const settings = (mode: RenderMode, cel: Partial<CelShadingSettings> = {}) =>
      setSceneRenderSettings(scene, {
        mode, quality, shadows,
        cel: normalizeCelShadingSettings({ outlinesEnabled: false, ...cel }),
        environmentLighting: normalizeEnvironmentLightingSettings({ celStrength: 0.8 }),
      });
    settings("pbr");
    // Prefiltered environment cubes with their irradiance, as the Scene's environment lighting builds one.
    const environmentCube = async (faces: Uint8Array[]) => {
      const source = new RawCubeTexture(scene, faces, 64, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, true);
      const filtered = retainFilteredEnvironment(engine, source);
      if (!filtered) throw new Error("This device cannot prefilter an environment cube.");
      releases.push(() => filtered.release());
      await filtered.ready;
      filtered.cube.sphericalPolynomial = await CubeMapToSphericalPolynomialTools.ConvertCubeMapTextureToSphericalPolynomial(source);
      return filtered.cube;
    };
    const sky = await environmentCube(Array.from({ length: 6 }, (_, index) => skyFace(index, 64)));
    const faces = await environmentCube(FACE_COLORS.map((color) => flatFace(color, 64)));
    const uniform = await environmentCube(Array.from({ length: 6 }, () => flatFace([UNIFORM_GREY, UNIFORM_GREY, UNIFORM_GREY], 64)));
    scene.environmentTexture = sky;
    scene.iblIntensity = 1;

    const compile = async (surface: Surface): Promise<NodeMaterial> => {
      const doc = createDefaultMaterialDocument(surface.name);
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [...surface.baseColor];
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [surface.metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [surface.roughness];
      output[materialPinDefaultPropertyKey("specular")] = [surface.specular];
      output[materialPinDefaultPropertyKey("environmentInfluence")] = [surface.environmentInfluence];
      const lowered = lowerMaterialDocument(doc);
      if (!lowered.ok) throw new Error(`${surface.name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name: surface.name });
      if (!compiled.ok) throw new Error(`${surface.name} did not compile`);
      await compiled.ready;
      return compiled.material;
    };
    const surfaces: NodeMaterial[] = [];
    for (const surface of SURFACES) surfaces.push(await compile(surface));
    const metal = await compile(WHITE_METAL);
    const matte = await compile(MATTE);
    const black = await compile(BLACK);
    const mirror = await compile(MIRROR);

    const floor = MeshBuilder.CreateGround("floor", { width: 9, height: 6 }, scene);
    const box = MeshBuilder.CreateBox("box", { size: 1.2 }, scene);
    box.position.set(-1.8, 0.6, 0.4);
    box.rotation.y = 0.6;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.4, segments: 24 }, scene);
    ball.position.set(1.7, 0.7, 0.2);
    const meshes: AbstractMesh[] = [floor, box, ball];
    const assign = (materials: NodeMaterial | NodeMaterial[]) =>
      meshes.forEach((mesh, index) => { mesh.material = Array.isArray(materials) ? materials[index]! : materials; });

    const authored = (light: Light, color: number[], intensity: number) => applyAuthoredLightProperties(light, {
      color, intensity, castShadows: false, range: 40, outerAngle: 70, innerAngle: 40, groundColor: [0.25, 0.2, 0.15] });
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
    authored(sun, [1, 0.95, 0.85], 0.7);
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    authored(fill, [0.6, 0.7, 1], 0.2);
    const spots = [[-2.6, 3, -0.5], [2.4, 3, 1.2]].map(([x, y, z], index) => {
      const light = new SpotLight(`spot-${index}`, new Vector3(x, y, z), new Vector3(0.1, -1, 0.15), 1, 2, scene);
      authored(light, index ? [0.2, 0.9, 0.3] : [0.9, 0.3, 0.2], 1.4);
      return light;
    });
    const points = [[-0.6, 1.6, -1.2], [1.4, 1.2, -1.5], [0, 1.8, 1.8]].map(([x, y, z], index) => {
      const light = new PointLight(`point-${index}`, new Vector3(x, y, z), scene);
      authored(light, [[0.3, 0.4, 1], [1, 0.8, 0.2], [1, 0.3, 0.9]][index]!, 0.9);
      return light;
    });
    const lights = [sun, fill, ...spots, ...points];
    // A rect light above the scene, facing down (Babylon's emits along -Z), off but in the rect light poses.
    retainAreaLightLookup(scene);
    const mount = new TransformNode("panel mount", scene);
    mount.position.set(0.3, 2.4, 0.2);
    mount.rotation.x = -Math.PI / 2;
    const panel = new OwnedRectAreaLight("panel", Vector3.Zero(), 4, 2.5, scene);
    panel.parent = mount;
    authored(panel, [1, 1, 1], 1);
    const gradient = emissionPixels("gradient", emissionTexel);
    const white = emissionPixels("white", () => [255, 255, 255]);
    const panelOnly = (intensity = 1) => {
      for (const light of lights) setAuthoredLightEnabled(light, false);
      authored(panel, [1, 1, 1], intensity);
      setAuthoredLightEnabled(panel, true);
    };
    const emit = (pixels: AreaEmissionPixels | undefined) => {
      setRectLightEmission(panel, pixels);
      panel._markMeshesAsLightDirty();
    };
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      return read();
    };
    /** Every light on but the panel, which goes back to plain white, and the sky cube unrotated and unprojected. */
    const restore = (materials?: NodeMaterial | NodeMaterial[]) => {
      if (materials) assign(materials);
      for (const light of lights) setAuthoredLightEnabled(light, true);
      authored(panel, [1, 1, 1], 1);
      setAuthoredLightEnabled(panel, false);
      emit(undefined);
      scene.environmentTexture = sky;
      scene.iblIntensity = 1;
      for (const cube of [sky, faces, uniform]) {
        cube.rotationY = 0;
        cube.boundingBoxSize = undefined as unknown as Vector3;
      }
      // The cubes are the Engine's, not the Scene's: its Materials learn of a change as a probe's do.
      scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
    };

    /**
     * What each pixel shows (readPixels' rows: WebGL2's bottom-up, WebGPU's top-down): the mesh (0 floor, 1 box, 2
     * ball, -1 none), a surface id (the floor 0, each box face its own, the ball 10) and, on the floor and the box,
     * the point and its flat normal.
     */
    // After a frame, which computes the camera's matrices.
    restore(surfaces);
    await draw();
    const geometry: { mesh: number; surface: number; point?: Vector3; normal?: Vector3 }[] = [];
    for (let row = 0; row < canvas.height; row++) {
      const y = engine.isWebGPU ? row + 0.5 : canvas.height - row - 0.5;
      for (let column = 0; column < canvas.width; column++) {
        const hit = scene.pickWithRay(scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera), (mesh) => meshes.includes(mesh));
        const mesh = hit?.pickedMesh ? meshes.indexOf(hit.pickedMesh) : -1;
        if (mesh < 0 || !hit?.pickedPoint) geometry.push({ mesh: -1, surface: -1 });
        else if (mesh === 2) geometry.push({ mesh, surface: 10 });
        else {
          const normal = hit.getNormal(true, true)!;
          const axes = [normal.x, normal.y, normal.z];
          const sizes = axes.map(Math.abs);
          const major = sizes.indexOf(Math.max(...sizes));
          const surface = mesh === 0 ? 0 : 1 + major * 2 + (axes[major]! > 0 ? 0 : 1);
          geometry.push({ mesh, surface, point: hit.pickedPoint.clone(), normal });
        }
      }
    }
    const eye = camera.position.clone();
    /** Per pixel, `value` where the pixel shows the floor or the box, else null. */
    const flat = <T>(value: (point: Vector3, normal: Vector3) => T) =>
      geometry.map((entry) => (entry.point && entry.normal ? value(entry.point, entry.normal) : null));
    const reflect = (point: Vector3, normal: Vector3) => {
      const toEye = eye.subtract(point).normalize();
      return normal.scale(2 * Vector3.Dot(normal, toEye)).subtract(toEye).normalize();
    };

    // Direct light against the oracle: MATTE everywhere, no environment (its scale zero, so the block adds none).
    const analytic: { name: string; pixels: number[]; expected: (Rgb | null)[] }[] = [];
    const analyticPoses: { name: string; apply: () => void }[] = [
      { name: "all lights", apply: () => undefined },
      { name: "two off", apply: () => { setAuthoredLightEnabled(points[1]!, false); setAuthoredLightEnabled(spots[1]!, false); } },
      { name: "sun only", apply: () => { for (const light of [fill, ...spots, ...points]) setAuthoredLightEnabled(light, false); } },
      { name: "fill only", apply: () => { for (const light of [sun, ...spots, ...points]) setAuthoredLightEnabled(light, false); } },
      { name: "local lights only", apply: () => { for (const light of [sun, fill]) setAuthoredLightEnabled(light, false); } },
    ];
    for (const pose of analyticPoses) {
      restore(matte);
      scene.iblIntensity = 0;
      pose.apply();
      analytic.push({
        name: pose.name, pixels: await draw(),
        expected: flat((point, normal) => directLight(point, normal, eye, linearBase(MATTE, engine.useExactSrgbConversions), MATTE.roughness, lights)),
      });
    }

    // Environment light, lights off. A mirror shows, per pixel, the colour of the face its reflected direction meets
    // (box-projected onto a probe's volume, then into the cube's frame, its rotation); `margin` is how far that
    // direction lies from a face's edge (its largest component over its second largest), as the prefiltered cube
    // blends faces there.
    const reflectedFace = (point: Vector3, normal: Vector3) => {
      let R = reflect(point, normal);
      if (faces.boundingBoxSize) {
        const half = faces.boundingBoxSize.scale(0.5);
        const centre = faces.boundingBoxPosition;
        const far = (axis: "x" | "y" | "z") =>
          Math.max((centre[axis] + half[axis] - point[axis]) / R[axis], (centre[axis] - half[axis] - point[axis]) / R[axis]);
        R = point.add(R.scale(Math.min(far("x"), far("y"), far("z")))).subtract(centre);
      }
      const d = Vector3.TransformNormal(R, faces.getReflectionTextureMatrix());
      const axes = [d.x, d.y, d.z];
      const sizes = axes.map(Math.abs);
      const sorted = [...sizes].sort((a, b) => b - a);
      const major = sizes.indexOf(sorted[0]!);
      return { face: major * 2 + (axes[major]! > 0 ? 0 : 1), margin: sorted[0]! / sorted[1]! };
    };
    const mirrors: { name: string; pixels: number[]; expected: ({ face: number; margin: number } | null)[] }[] = [];
    const mirrorPoses: { name: string; apply: () => void }[] = [
      { name: "faces", apply: () => undefined },
      { name: "rotated faces", apply: () => { faces.rotationY = 1.1; } },
      { name: "box-projected faces", apply: () => {
        faces.boundingBoxPosition = new Vector3(0.5, 1.5, 0.5);
        faces.boundingBoxSize = new Vector3(8, 4, 7);
      } },
      { name: "rotated box-projected faces", apply: () => {
        faces.rotationY = -0.7;
        faces.boundingBoxPosition = new Vector3(-0.4, 1, 0.8);
        faces.boundingBoxSize = new Vector3(6, 3, 9);
      } },
    ];
    for (const pose of mirrorPoses) {
      restore(mirror);
      for (const light of lights) setAuthoredLightEnabled(light, false);
      scene.environmentTexture = faces;
      pose.apply();
      scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
      mirrors.push({ name: pose.name, pixels: await draw(), expected: flat(reflectedFace) });
    }
    // The furnace: in a uniform cube a rough white metal reflects exactly the cube's colour (the multi-scatter term
    // restores what the single-scatter table loses), and MATTE adds its diffuse colour times the cube's irradiance
    // over BLACK, which reflects as MATTE does.
    const furnace: Record<string, number[]> = {};
    for (const [name, material] of [["white metal", metal], ["matte", matte], ["black", black]] as const) {
      restore(material);
      for (const light of lights) setAuthoredLightEnabled(light, false);
      scene.environmentTexture = uniform;
      scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
      furnace[name] = await draw();
    }

    // The rect light alone, without environment: MATTE over BLACK by the diffuse colour times the form factor; a
    // mirror shows the panel's own radiance where the reflected ray meets it and nothing elsewhere; a white emission
    // draws as the flat light, and a mirror shows a gradient emission's colours where its rays meet them.
    const world = mount.getWorldMatrix();
    const centre = Vector3.TransformCoordinates(panel.position, world);
    const halfWidth = Vector3.TransformNormal(new Vector3(panel.width / 2, 0, 0), world);
    const halfHeight = Vector3.TransformNormal(new Vector3(0, panel.height / 2, 0), world);
    const corners = [
      centre.add(halfWidth).subtract(halfHeight), centre.subtract(halfWidth).subtract(halfHeight),
      centre.subtract(halfWidth).add(halfHeight), centre.add(halfWidth).add(halfHeight),
    ];
    const RECT_MIRROR_INTENSITY = 0.4;
    const rectPoses: { name: string; material: NodeMaterial; intensity?: number; emission?: AreaEmissionPixels }[] = [
      { name: "matte", material: matte },
      { name: "black", material: black },
      { name: "matte, white emission", material: matte, emission: white },
      { name: "mirror", material: mirror, intensity: RECT_MIRROR_INTENSITY },
      { name: "mirror, white emission", material: mirror, intensity: RECT_MIRROR_INTENSITY, emission: white },
      { name: "mirror, gradient emission", material: mirror, intensity: RECT_MIRROR_INTENSITY, emission: gradient },
    ];
    const rectCaptures: Record<string, number[]> = {};
    for (const pose of rectPoses) {
      restore(pose.material);
      scene.iblIntensity = 0;
      panelOnly(pose.intensity);
      if (pose.emission) emit(pose.emission);
      rectCaptures[pose.name] = await draw();
    }
    /**
     * Where the mirror's reflected ray meets the panel: the hit in the panel's own axes, 0 to 1 along its width (from
     * the half width's negative end) and its height, and how far inside the panel's edge it lies (in those units).
     */
    const planeNormal = Vector3.Cross(halfWidth, halfHeight).normalize();
    const rectMirror = flat((point, normal) => {
      const R = reflect(point, normal);
      const along = Vector3.Dot(R, planeNormal);
      const t = Math.abs(along) < 1e-6 ? -1 : Vector3.Dot(centre.subtract(point), planeNormal) / along;
      if (t <= 0) return null;
      const offset = point.add(R.scale(t)).subtract(centre);
      const u = 0.5 + Vector3.Dot(offset, halfWidth) / (2 * halfWidth.lengthSquared());
      const v = 0.5 + Vector3.Dot(offset, halfHeight) / (2 * halfHeight.lengthSquared());
      return { u, v, inside: Math.min(u, 1 - u, v, 1 - v) };
    });
    const rect = {
      captures: rectCaptures, mirrorIntensity: RECT_MIRROR_INTENSITY, mirror: rectMirror,
      formFactors: flat((point, normal) => rectFormFactor(point, normal, corners)),
    };

    // The regular surfaces under the sky cube, for poses that must differ.
    const captures: { name: string; pixels: number[] }[] = [];
    const poses: { name: string; apply: () => void }[] = [
      { name: "all lights", apply: () => undefined },
      { name: "two off", apply: () => { setAuthoredLightEnabled(points[1]!, false); setAuthoredLightEnabled(spots[1]!, false); } },
      { name: "environment only", apply: () => { for (const light of lights) setAuthoredLightEnabled(light, false); } },
      { name: "rotated environment", apply: () => { for (const light of lights) setAuthoredLightEnabled(light, false); sky.rotationY = 1.1; } },
      { name: "box-projected environment", apply: () => {
        for (const light of lights) setAuthoredLightEnabled(light, false);
        sky.boundingBoxPosition = new Vector3(0.5, 1.5, 0.5);
        sky.boundingBoxSize = new Vector3(8, 4, 7);
        scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
      } },
      { name: "rect light", apply: () => panelOnly() },
    ];
    for (const pose of poses) {
      restore(surfaces);
      pose.apply();
      captures.push({ name: pose.name, pixels: await draw() });
    }

    // Lights switching, arriving and leaving compile nothing new.
    const lightSteps = async () => {
      restore(surfaces);
      await draw();
      const before = litEffectKeys(engine);
      const steps: { step: string; newLitEffects: number }[] = [];
      const step = async (name: string, change: () => void) => {
        change();
        await draw();
        steps.push({ step: name, newLitEffects: litEffectKeys(engine).filter((key) => !before.includes(key)).length });
      };
      let added: Light | undefined;
      await step("a point switched off", () => setAuthoredLightEnabled(points[2]!, false));
      await step("a spot switched off", () => setAuthoredLightEnabled(spots[1]!, false));
      await step("the fill switched off", () => setAuthoredLightEnabled(fill, false));
      await step("all back on", () => restore());
      await step("a new point", () => { added = new PointLight("added", new Vector3(0.6, 1.5, -0.4), scene); authored(added, [0.3, 1, 0.9], 0.9); });
      await step("a point removed", () => added!.dispose());
      return { steps, effects: before };
    };
    const pbr = await lightSteps();

    // CEL: the block's HAPTIC_CEL define over the same records.
    const local = [...spots, ...points];
    const celPoses: { name: string; cel?: Partial<CelShadingSettings>; apply: () => void }[] = [
      { name: "sun and fill", apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "sun only", apply: () => [fill, ...local].forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "fill only", apply: () => [sun, ...local].forEach((light) => setAuthoredLightEnabled(light, false)) },
      // A low threshold puts the environment's light in the lit band, which shows its hue and so the cube's rotation.
      { name: "environment only", cel: { shadowThreshold: 0.2 }, apply: () => lights.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "rotated environment", cel: { shadowThreshold: 0.2 }, apply: () => { lights.forEach((light) => setAuthoredLightEnabled(light, false)); sky.rotationY = 1.1; } },
      { name: "additive", cel: { lightMixing: "additive" }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "blend", cel: { lightMixing: "blend" }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "wide highlights", cel: { specularSize: 0.5, specularStrength: 0.6 }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "no highlights", cel: { specularEnabled: false }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "rect light", apply: () => panelOnly() },
      { name: "all lights", apply: () => undefined },
    ];
    settings("cel");
    const celCaptures: { name: string; pixels: number[] }[] = [];
    for (const pose of celPoses) {
      settings("cel", pose.cel);
      restore(surfaces);
      pose.apply();
      celCaptures.push({ name: pose.name, pixels: await draw() });
    }
    settings("cel");
    const cel = await lightSteps();

    /**
     * Per pixel, in readPixels' rows: 1 where the box or the ball blocks the floor's view of a light (`toLight`: from a
     * floor point to the light), 0 where nothing does, -1 off the floor.
     */
    const floorShadowMask = (toLight: (point: Vector3) => Vector3) => geometry.map((entry) => {
      if (entry.mesh !== 0 || !entry.point) return -1;
      const offset = toLight(entry.point);
      const length = offset.length();
      const towards = new Ray(entry.point, offset.scaleInPlace(1 / length), length);
      return scene.pickWithRay(towards, (mesh) => mesh === box || mesh === ball)?.hit ? 1 : 0;
    });
    // A spot light behind the box aims through it, so the box's shadow falls toward the camera where it shines
    // brightest; the sun shines toward the camera too, and a bulb behind and between the box and the ball lights the
    // floor through several of its cube faces.
    const lamp = new SpotLight("shadowed lamp", new Vector3(-1.8, 3.4, 1.8), new Vector3(0, -3.4, -2.1).normalize(), 1, 2, scene);
    applyAuthoredLightProperties(lamp, { color: [1, 0.95, 0.9], intensity: 50, castShadows: false, range: 40, outerAngle: 90, innerAngle: 60 });
    const bulb = new PointLight("shadowed bulb", new Vector3(0, 2.4, 1.6), scene);
    applyAuthoredLightProperties(bulb, { color: [1, 0.9, 0.8], intensity: 30, castShadows: false, range: 40 });
    /**
     * `light`'s shadow, drawn into the Scene's atlas through the shadow controller and the frame graph as Play draws
     * it, and read by programs that compile nothing for it. Per render mode: the light with its shadow, with its
     * shadow switched off (`shadowEnabled`) and off itself, every other light off; and whether its map draws into the
     * atlas.
     */
    const shadowPoses = async (light: Light, cast: () => void) => {
      cast();
      const drawShadowed = async () => {
        // A new or resumed map samples neutrally until it has drawn.
        for (let frame = 0; frame < 60 && (light.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() !== 0; frame++) await draw();
        return draw();
      };
      const modes: { mode: RenderMode; atlas: boolean; shadowed: number[]; unshadowed: number[]; unlit: number[]; newLitEffects: number }[] = [];
      for (const mode of ["pbr", "cel"] as const) {
        settings(mode);
        restore(surfaces);
        for (const other of [...lights, lamp, bulb]) setAuthoredLightEnabled(other, other === light);
        await draw();
        const before = litEffectKeys(engine);
        const shadowed = await drawShadowed();
        const atlas = isAtlasShadow(light.getShadowGenerator());
        light.shadowEnabled = false;
        const unshadowed = await draw();
        light.shadowEnabled = true;
        setAuthoredLightEnabled(light, false);
        const unlit = await draw();
        setAuthoredLightEnabled(light, true);
        modes.push({ mode, atlas, shadowed, unshadowed, unlit, newLitEffects: litEffectKeys(engine).filter((key) => !before.includes(key)).length });
      }
      return modes;
    };
    const spotShadow = {
      modes: await shadowPoses(lamp, () => applyAuthoredLightProperties(lamp, {
        color: [1, 0.95, 0.9], intensity: 50, castShadows: true, range: 40, outerAngle: 90, innerAngle: 60 })),
      blocked: floorShadowMask((point) => lamp.getAbsolutePosition().subtract(point)),
    };
    // The sun's cascades, its map's other cascades lit by the same sun.
    const sunShadow = {
      modes: await shadowPoses(sun, () => {
        applyAuthoredLightProperties(lamp, { color: [1, 0.95, 0.9], intensity: 50, castShadows: false, range: 40, outerAngle: 90, innerAngle: 60 });
        sun.direction = new Vector3(-0.25, -0.75, -0.9);
        applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });
      }),
      blocked: floorShadowMask(() => sun.direction.normalizeToNew().scaleInPlace(-100)),
    };
    // The bulb's faces, the sun's map released.
    const pointShadow = {
      modes: await shadowPoses(bulb, () => {
        applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: false, range: 40, outerAngle: 70, innerAngle: 40 });
        applyAuthoredLightProperties(bulb, { color: [1, 0.9, 0.8], intensity: 30, castShadows: true, range: 40 });
      }),
      blocked: floorShadowMask((point) => bulb.getAbsolutePosition().subtract(point)),
    };
    const shadow = { spot: spotShadow, sun: sunShadow, point: pointShadow };
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    const lightDefines = litEffectKeys(engine).filter((key) => /#define LIGHT\d/.test(effects[key]!.defines)).length;
    const celEffects = cel.effects.filter((key) => /#define HAPTIC_CEL/.test(effects[key]!.defines)).length;
    const imageProcessing = scene.imageProcessingConfiguration;
    graph.dispose();
    return {
      width: canvas.width, height: canvas.height, surfaceIds: geometry.map((entry) => entry.surface),
      // The display conversion the expectations go through: none but the sRGB encoding (2.2 unless exact).
      display: {
        toneMapping: imageProcessing.toneMappingEnabled, exposure: imageProcessing.exposure, contrast: imageProcessing.contrast,
        exactSrgb: engine.useExactSrgbConversions,
      },
      analytic, mirrors, faceColors: FACE_COLORS, furnace, uniformGrey: UNIFORM_GREY, rect,
      captures, steps: pbr.steps, hapticEffects: pbr.effects.length, lightDefines,
      celCaptures, celSteps: cel.steps, celEffects, shadow,
    };
  } finally {
    for (const release of releases) release();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
