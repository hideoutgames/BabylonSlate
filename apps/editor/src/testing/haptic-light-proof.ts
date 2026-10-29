/**
 * Test-build-only oracle for the lighting plan's HapticLightingBlock: the same graph Materials, lights and
 * environment cube drawn by Babylon's PBR and CEL blocks and by HapticLightingBlock, on the real GPU, through the
 * Forward FrameGraph, and HapticLightingBlock's Effects across light changes in both render modes.
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
  setHapticLighting,
  setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import type { AreaEmissionPixels } from "@haptic/assets";
import { setRectLightEmission } from "../../../../packages/render/src/area-emission-array";
import { retainAreaEmissionTexture } from "../../../../packages/render/src/area-emission-resource";
import { retainAreaLightLookup } from "../../../../packages/render/src/area-light-resources";
import { OwnedRectAreaLight } from "../../../../packages/render/src/area-rect-light";
import { retainFilteredEnvironment } from "../../../../packages/render/src/environment-prefilter";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { isAtlasShadow } from "../../../../packages/render/src/shadow-atlas";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Path = "babylon" | "haptic";
const SURFACES = [
  { name: "rough dielectric", baseColor: [0.8, 0.8, 0.8], metallic: 0, specular: 0.5, roughness: 0.6, environmentInfluence: 1 },
  { name: "smooth metal", baseColor: [0.95, 0.75, 0.35], metallic: 1, specular: 0.5, roughness: 0.25, environmentInfluence: 1 },
  // Water's Specular: Babylon's block takes it as an index of refraction of 1.333.
  { name: "glossy dielectric", baseColor: [0.2, 0.35, 0.8], metallic: 0, specular: 0.255, roughness: 0.15, environmentInfluence: 0.5 },
] as const;
type Surface = { name: string; baseColor: readonly number[]; metallic: number; specular: number; roughness: number; environmentInfluence: number };
// Babylon's rect light specular weighs its Fresnel terms by the light's specular colour times intensity; the block
// uses the standard LTC Fresnel. The two agree for a white metal under a white light of intensity one.
const WHITE_METAL: Surface = { name: "white metal", baseColor: [1, 1, 1], metallic: 1, specular: 0.5, roughness: 0.4, environmentInfluence: 1 };

/** A prepared emission's pixels: warm to cool across, light to dark down, as Prepare Emission's 1024 square. */
function emissionPixels(): AreaEmissionPixels {
  const edge = 1024;
  const rgba = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const offset = (y * edge + x) * 4;
      const across = x / edge;
      const down = 0.4 + 0.6 * (1 - y / edge);
      rgba.set([255 * down * (1 - 0.6 * across), 255 * down * 0.8, 255 * down * (0.4 + 0.6 * across), 255], offset);
    }
  }
  return { metadata: { processor: "haptic-light-proof", pixelsHash: "gradient", width: edge, height: edge }, rgba } as unknown as AreaEmissionPixels;
}

/** A cube face's pixels: a sky gradient from a bright zenith to a dark ground, tinted per face. */
function face(index: number, size: number): Uint8Array {
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

function litEffectKeys(engine: AbstractEngine): string[] {
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  return Object.keys(effects).filter((key) => effects[key]!.fragmentSourceCode.includes("HapticLights")).sort();
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
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 3.6, -7), scene);
    camera.setTarget(new Vector3(0, 0.5, 0));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    // As Play's world Scene: Babylon's light helpers ask the fixed-shape hooks first.
    setFixedShapeLightingWorldScene(scene);
    const quality = normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } });
    // One local shadow and the sun's two cascades, which only the shadow poses cast, biased past the acne a slanting
    // light would show on the floor (as on Babylon's own spot shadows: the default bias, measured, draws the same
    // stripes on both paths).
    const shadows = normalizeShadowSettings({ cascades: 2, maxLocalLights: 1, depthBias: 0.0008 });
    const settings = (mode: RenderMode, cel: Partial<CelShadingSettings> = {}) =>
      setSceneRenderSettings(scene, {
        mode, quality, shadows,
        cel: normalizeCelShadingSettings({ outlinesEnabled: false, ...cel }),
        environmentLighting: normalizeEnvironmentLightingSettings({ celStrength: 0.8 }),
      });
    settings("pbr");
    // A prefiltered environment cube with its irradiance, as the Scene's environment lighting builds one.
    const source = new RawCubeTexture(scene, Array.from({ length: 6 }, (_, index) => face(index, 64)), 64,
      Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, true);
    const filtered = retainFilteredEnvironment(engine, source);
    if (!filtered) throw new Error("This device cannot prefilter an environment cube.");
    await filtered.ready;
    filtered.cube.sphericalPolynomial = await CubeMapToSphericalPolynomialTools.ConvertCubeMapTextureToSphericalPolynomial(source);
    scene.environmentTexture = filtered.cube;
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
    // The switch picks the lighting block when a Material compiles.
    const materials: Record<Path, NodeMaterial[]> = { babylon: [], haptic: [] };
    for (const surface of SURFACES) materials.babylon.push(await compile(surface));
    const metal = { babylon: await compile(WHITE_METAL) } as Record<Path, NodeMaterial>;
    setHapticLighting(engine, true);
    for (const surface of SURFACES) materials.haptic.push(await compile(surface));
    metal.haptic = await compile(WHITE_METAL);

    const floor = MeshBuilder.CreateGround("floor", { width: 9, height: 6 }, scene);
    const box = MeshBuilder.CreateBox("box", { size: 1.2 }, scene);
    box.position.set(-1.8, 0.6, 0.4);
    box.rotation.y = 0.6;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.4, segments: 24 }, scene);
    ball.position.set(1.7, 0.7, 0.2);
    const meshes: AbstractMesh[] = [floor, box, ball];
    const assign = (path: Path) => meshes.forEach((mesh, index) => { mesh.material = materials[path][index]!; });

    // Every colour peaks at one, the white specular colour Babylon's CEL highlights take on (see hapticCelHighlight).
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
    // Its emission: a texture of its own on Babylon's path, a layer of the block's array on the other.
    const emission = emissionPixels();
    const emissionTexture = retainAreaEmissionTexture(engine, emission);
    const setEmission = (on: boolean) => {
      panel.emissionTexture = on ? emissionTexture.texture : null;
      panel._markMeshesAsLightDirty();
      setRectLightEmission(panel, on ? emission : undefined);
    };
    panel.parent = mount;
    authored(panel, [1, 1, 1], 1);
    const panelOnly = () => {
      for (const light of lights) setAuthoredLightEnabled(light, false);
      setAuthoredLightEnabled(panel, true);
    };
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      return read();
    };
    const restore = (path?: Path) => {
      if (path) assign(path);
      for (const light of lights) setAuthoredLightEnabled(light, true);
      setAuthoredLightEnabled(panel, false);
      if (panel.emissionTexture) setEmission(false);
      filtered.cube.rotationY = 0;
      filtered.cube.boundingBoxSize = undefined as unknown as Vector3;
      scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
    };
    const poses: { name: string; apply: (path: Path) => void; blockOnly?: boolean }[] = [
      { name: "all lights", apply: () => undefined },
      { name: "two off", apply: () => { setAuthoredLightEnabled(points[1]!, false); setAuthoredLightEnabled(spots[1]!, false); } },
      { name: "sun only", apply: () => { for (const light of [fill, ...spots, ...points]) setAuthoredLightEnabled(light, false); } },
      { name: "environment only", apply: () => { for (const light of lights) setAuthoredLightEnabled(light, false); } },
      { name: "rotated environment", apply: () => { filtered.cube.rotationY = 1.1; } },
      // A reflection probe's box projection.
      { name: "box-projected environment", apply: () => {
        filtered.cube.boundingBoxPosition = new Vector3(0.5, 1.5, 0.5);
        filtered.cube.boundingBoxSize = new Vector3(8, 4, 7);
        // The cube is the Engine's, not the Scene's: its Materials learn of the box as a probe's do.
        scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
      } },
      { name: "rect light on metal", apply: (path) => { panelOnly(); for (const mesh of meshes) mesh.material = metal[path]; } },
      { name: "emissive rect light on metal", apply: (path) => {
        panelOnly();
        setEmission(true);
        for (const mesh of meshes) mesh.material = metal[path];
      } },
      // The standard LTC Fresnel differs from Babylon's on dielectrics, by design.
      { name: "rect light", apply: panelOnly, blockOnly: true },
    ];
    const captures: { name: string; path: Path; pixels: number[] }[] = [];
    for (const path of ["babylon", "haptic"] as const) {
      for (const pose of poses) {
        if (pose.blockOnly && path === "babylon") continue;
        // Babylon's WGSL reflection block reads a box's uniforms without their `uniforms.` prefix and fails to compile.
        if (path === "babylon" && engine.isWebGPU && pose.name === "box-projected environment") continue;
        restore(path);
        pose.apply(path);
        captures.push({ name: pose.name, path, pixels: await draw() });
      }
    }

    // Lights switching, arriving and leaving compile nothing new.
    const lightSteps = async () => {
      restore("haptic");
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

    // CEL: Babylon's CelLightBlock graphs against the block's HAPTIC_CEL. Point and spot lights fall off physically
    // on the block, by design, so they light the block's poses only.
    const local = [...spots, ...points];
    const celPoses: { name: string; cel?: Partial<CelShadingSettings>; apply: () => void; blockOnly?: boolean }[] = [
      { name: "sun and fill", apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "sun only", apply: () => [fill, ...local].forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "fill only", apply: () => [sun, ...local].forEach((light) => setAuthoredLightEnabled(light, false)) },
      // A low threshold puts the environment's light in the lit band, which shows its hue and so the cube's rotation.
      { name: "environment only", cel: { shadowThreshold: 0.2 }, apply: () => lights.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "rotated environment", cel: { shadowThreshold: 0.2 }, apply: () => { lights.forEach((light) => setAuthoredLightEnabled(light, false)); filtered.cube.rotationY = 1.1; } },
      { name: "additive", cel: { lightMixing: "additive" }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "blend", cel: { lightMixing: "blend" }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "wide highlights", cel: { specularSize: 0.5, specularStrength: 0.6 }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      { name: "no highlights", cel: { specularEnabled: false }, apply: () => local.forEach((light) => setAuthoredLightEnabled(light, false)) },
      // Babylon's light block draws a rect light far dimmer than its PBR block does, so no reference.
      { name: "rect light", apply: panelOnly, blockOnly: true },
      { name: "all lights", apply: () => undefined, blockOnly: true },
    ];
    settings("cel");
    const celCaptures: { name: string; path: Path; pixels: number[] }[] = [];
    for (const path of ["babylon", "haptic"] as const) {
      for (const pose of celPoses) {
        if (pose.blockOnly && path === "babylon") continue;
        settings("cel", pose.cel);
        restore(path);
        pose.apply();
        celCaptures.push({ name: pose.name, path, pixels: await draw() });
      }
    }
    settings("cel");
    const cel = await lightSteps();

    /**
     * Per pixel, in readPixels' rows (WebGL2's bottom-up, WebGPU's swap chain texture's top-down): 1 where the box or
     * the ball blocks the floor's view of a light (`toLight`: from a floor point to the light), 0 where nothing does, -1
     * off the floor.
     */
    const floorShadowMask = (toLight: (point: Vector3) => Vector3) => {
      const mask: number[] = [];
      for (let row = 0; row < canvas.height; row++) {
        const y = engine.isWebGPU ? row + 0.5 : canvas.height - row - 0.5;
        for (let column = 0; column < canvas.width; column++) {
          const hit = scene.pickWithRay(scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera),
            (mesh) => meshes.includes(mesh));
          if (hit?.pickedMesh !== floor || !hit.pickedPoint) {
            mask.push(-1);
            continue;
          }
          const offset = toLight(hit.pickedPoint);
          const length = offset.length();
          const towards = new Ray(hit.pickedPoint, offset.scaleInPlace(1 / length), length);
          mask.push(scene.pickWithRay(towards, (mesh) => mesh === box || mesh === ball)?.hit ? 1 : 0);
        }
      }
      return mask;
    };
    // A spot light behind the box aims through it, so the box's shadow falls toward the camera where it shines
    // brightest; the sun shines toward the camera too, and a bulb behind and between the box and the ball lights the
    // floor through several of its cube faces.
    const lamp = new SpotLight("shadowed lamp", new Vector3(-1.8, 3.4, 1.8), new Vector3(0, -3.4, -2.1).normalize(), 1, 2, scene);
    applyAuthoredLightProperties(lamp, { color: [1, 0.95, 0.9], intensity: 50, castShadows: false, range: 40, outerAngle: 90, innerAngle: 60 });
    const bulb = new PointLight("shadowed bulb", new Vector3(0, 2.4, 1.6), scene);
    applyAuthoredLightProperties(bulb, { color: [1, 0.9, 0.8], intensity: 30, castShadows: false, range: 40 });
    /**
     * `light`'s shadow on the block's path, drawn into the Scene's atlas through the shadow controller and the frame
     * graph as Play draws it, and read by programs that compile nothing for it. Per render mode: the light with its
     * shadow, with its shadow switched off (`shadowEnabled`) and off itself, every other light off; and whether its
     * map draws into the atlas.
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
        restore("haptic");
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
    graph.dispose();
    emissionTexture.release();
    filtered.release();
    return {
      width: canvas.width, height: canvas.height, captures, steps: pbr.steps, hapticEffects: pbr.effects.length, lightDefines,
      celCaptures, celSteps: cel.steps, celEffects, shadow,
    };
  } finally {
    setHapticLighting(engine, false);
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
