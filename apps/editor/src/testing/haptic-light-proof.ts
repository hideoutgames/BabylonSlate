/**
 * Test-build-only oracle for the lighting plan's HapticLightingBlock: the same graph Materials, lights and
 * environment cube drawn by Babylon's PBR block and by HapticLightingBlock, on the real GPU, through the Forward
 * FrameGraph, and HapticLightingBlock's Effects across light changes.
 */
import {
  Color4,
  Constants,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PointLight,
  RawCubeTexture,
  Scene,
  SpotLight,
  Vector3,
  type AbstractMesh,
  type Effect,
  type Light,
  type NodeMaterial,
} from "@babylonjs/core";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, setHapticLighting, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { retainFilteredEnvironment } from "../../../../packages/render/src/environment-prefilter";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Path = "babylon" | "haptic";
const SURFACES = [
  { name: "rough dielectric", baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.6 },
  { name: "smooth metal", baseColor: [0.95, 0.75, 0.35], metallic: 1, roughness: 0.25 },
  { name: "glossy dielectric", baseColor: [0.2, 0.35, 0.8], metallic: 0, roughness: 0.15 },
] as const;

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

function litEffectKeys(engine: Engine): string[] {
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  return Object.keys(effects).filter((key) => effects[key]!.fragmentSourceCode.includes("uniform HapticLights")).sort();
}

export async function runHapticLightProof() {
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 80;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const order = readbackChannelOrder(false);
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
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }),
    });
    // A prefiltered environment cube with its irradiance, as the Scene's environment lighting builds one.
    const source = new RawCubeTexture(scene, Array.from({ length: 6 }, (_, index) => face(index, 64)), 64,
      Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, true);
    const filtered = retainFilteredEnvironment(engine, source);
    if (!filtered) throw new Error("This device cannot prefilter an environment cube.");
    await filtered.ready;
    filtered.cube.sphericalPolynomial = await CubeMapToSphericalPolynomialTools.ConvertCubeMapTextureToSphericalPolynomial(source);
    scene.environmentTexture = filtered.cube;
    scene.iblIntensity = 1;

    const compile = async (surface: (typeof SURFACES)[number]): Promise<NodeMaterial> => {
      const doc = createDefaultMaterialDocument(surface.name);
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [...surface.baseColor];
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [surface.metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [surface.roughness];
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
    setHapticLighting(engine, true);
    for (const surface of SURFACES) materials.haptic.push(await compile(surface));

    const floor = MeshBuilder.CreateGround("floor", { width: 9, height: 6 }, scene);
    const box = MeshBuilder.CreateBox("box", { size: 1.2 }, scene);
    box.position.set(-1.8, 0.6, 0.4);
    box.rotation.y = 0.6;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.4, segments: 24 }, scene);
    ball.position.set(1.7, 0.7, 0.2);
    const meshes: AbstractMesh[] = [floor, box, ball];
    const assign = (path: Path) => meshes.forEach((mesh, index) => { mesh.material = materials[path][index]!; });

    const authored = (light: Light, color: number[], intensity: number) =>
      applyAuthoredLightProperties(light, { color, intensity, castShadows: false, range: 40, outerAngle: 70, innerAngle: 40 });
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
    authored(sun, [1, 0.95, 0.85], 0.7);
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    authored(fill, [0.3, 0.35, 0.5], 0.35);
    const spots = [[-2.6, 3, -0.5], [2.4, 3, 1.2]].map(([x, y, z], index) => {
      const light = new SpotLight(`spot-${index}`, new Vector3(x, y, z), new Vector3(0.1, -1, 0.15), 1, 2, scene);
      authored(light, index ? [0.2, 0.9, 0.3] : [0.9, 0.3, 0.2], 1.4);
      return light;
    });
    const points = [[-0.6, 1.6, -1.2], [1.4, 1.2, -1.5], [0, 1.8, 1.8]].map(([x, y, z], index) => {
      const light = new PointLight(`point-${index}`, new Vector3(x, y, z), scene);
      authored(light, [[0.3, 0.4, 1], [1, 0.8, 0.2], [0.8, 0.3, 0.9]][index]!, 0.9);
      return light;
    });
    const lights = [sun, fill, ...spots, ...points];
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      return read();
    };
    const restore = () => {
      for (const light of lights) setAuthoredLightEnabled(light, true);
      filtered.cube.rotationY = 0;
      filtered.cube.boundingBoxSize = undefined as unknown as Vector3;
      scene.markAllMaterialsAsDirty(Constants.MATERIAL_TextureDirtyFlag);
    };
    const poses: { name: string; apply: () => void }[] = [
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
    ];
    const captures: { name: string; path: Path; pixels: number[] }[] = [];
    for (const path of ["babylon", "haptic"] as const) {
      assign(path);
      for (const pose of poses) {
        restore();
        pose.apply();
        captures.push({ name: pose.name, path, pixels: await draw() });
      }
    }

    // Lights switching, arriving and leaving compile nothing new.
    assign("haptic");
    restore();
    await draw();
    const before = litEffectKeys(engine);
    const steps: { step: string; newLitEffects: number }[] = [];
    const step = async (name: string, change: () => void) => {
      change();
      await draw();
      steps.push({ step: name, newLitEffects: litEffectKeys(engine).filter((key) => !before.includes(key)).length });
    };
    await step("a point switched off", () => setAuthoredLightEnabled(points[2]!, false));
    await step("a spot switched off", () => setAuthoredLightEnabled(spots[1]!, false));
    await step("the fill switched off", () => setAuthoredLightEnabled(fill, false));
    await step("all back on", restore);
    await step("a new point", () => authored(new PointLight("added", new Vector3(0.6, 1.5, -0.4), scene), [0.3, 1, 0.9], 0.9));
    await step("a point removed", () => points[0]!.dispose());
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    const lightDefines = litEffectKeys(engine).filter((key) => /#define LIGHT\d/.test(effects[key]!.defines)).length;
    graph.dispose();
    filtered.release();
    return { width: canvas.width, height: canvas.height, captures, steps, hapticEffects: before.length, lightDefines };
  } finally {
    setHapticLighting(engine, false);
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
