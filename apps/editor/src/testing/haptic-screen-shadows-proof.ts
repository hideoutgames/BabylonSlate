/**
 * Test-build-only oracle for Screen-Space Shadows: under a grazing sun with a deliberately coarse map, a floor holding a
 * resting box, a 1 cm plank, a sphere, a pole and a glass pane, and a 30° ramp facing the sun, drawn with the screen
 * shadows off and at High through the Forward FrameGraph, in PBR and CEL, with a ray-cast mask of the floor and ramp
 * pixels whose short view of the sun something blocks (contact shadows the march can find), and of the pixels seen
 * through the glass.
 */
import {
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  Matrix,
  MeshBuilder,
  Ray,
  Scene,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type CascadedShadowGenerator,
} from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
  type RenderMode,
  type ScreenShadowsQuality,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { allowSceneScreenShadows, sceneRenderingSettings } from "../../../../packages/render/src/render-settings";
import { SCREEN_SHADOW_LEVELS } from "../../../../packages/render/src/screen-shadows";
import { spatialEffectsUnsupported } from "../../../../packages/render/src/spatial-effects";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Capture = { name: string; pixels: number[]; screenShadows: boolean };
/** Per pixel: the surface hit (floor, ramp, other, glass-covered floor) and whether a caster blocks its sun within reach. */
type Mask = { surface: ("floor" | "ramp" | "glass" | "other")[]; contact: boolean[]; open: boolean[]; distance: number[] };

export async function runHapticScreenShadowsProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 100;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(canvas.width, canvas.height);
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 2.4, -5), scene);
    camera.setTarget(new Vector3(0, 0.2, 1.5));
    camera.minZ = 0.1;
    camera.maxZ = 200;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    allowSceneScreenShadows(scene);
    const settings = (mode: RenderMode, screenShadows: ScreenShadowsQuality) => setSceneRenderSettings(scene, {
      mode, quality: normalizeRenderingQuality({}),
      // One coarse cascade: about 4 texels per metre, which misses the plank's and the contacts' shadows.
      shadows: normalizeShadowSettings({ cascades: 1, mapSize: 256, distance: 60, filterQuality: "medium", depthBias: 0.001, screenShadows }),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
    });
    settings("pbr", "off");

    const doc = createDefaultMaterialDocument("rough dielectric");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.7];
    output[materialPinDefaultPropertyKey("environmentInfluence")] = [0];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("The surface did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "rough dielectric" });
    if (!compiled.ok) throw new Error("The surface did not compile");
    await compiled.ready;

    const floor = MeshBuilder.CreateGround("floor", { width: 12, height: 80 }, scene);
    floor.position.z = 36;
    const box = MeshBuilder.CreateBox("box", { size: 0.6 }, scene);
    box.position.set(-1.4, 0.3, 0.8);
    box.rotation.y = 0.4;
    const plank = MeshBuilder.CreateBox("plank", { width: 1.2, height: 0.01, depth: 0.25 }, scene);
    plank.position.set(0.1, 0.005, 0.2);
    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 0.5, segments: 24 }, scene);
    sphere.position.set(1.3, 0.25, 0.6);
    const pole = MeshBuilder.CreateCylinder("pole", { diameter: 0.06, height: 1.4, tessellation: 12 }, scene);
    pole.position.set(0.4, 0.7, 1.6);
    const ramp = MeshBuilder.CreateBox("ramp", { width: 1.4, height: 0.02, depth: 1.2 }, scene);
    ramp.position.set(2.6, 0.3, 2.4);
    ramp.rotation.x = -Math.PI / 6;
    const casters: AbstractMesh[] = [box, plank, sphere, pole, ramp];
    for (const mesh of [floor, ...casters]) mesh.material = compiled.material;
    // A glass pane in front of floor the box's contact shadow lies on: blended, drawn over that floor.
    const glass = MeshBuilder.CreatePlane("glass", { width: 0.9, height: 0.6 }, scene);
    glass.position.set(-1.4, 0.3, -0.2);
    const glassDoc = createDefaultMaterialDocument("glass");
    glassDoc.blendMode = "translucent";
    glassDoc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.6, 0.8, 1];
    glassDoc.nodes.find((node) => node.id === "output")!.properties[materialPinDefaultPropertyKey("opacity")] = [0.3];
    const loweredGlass = lowerMaterialDocument(glassDoc);
    if (!loweredGlass.ok) throw new Error("The glass did not lower");
    const glassCompiled = compileMaterialPlan(loweredGlass.plan, { scene, name: "glass" });
    if (!glassCompiled.ok) throw new Error("The glass did not compile");
    await glassCompiled.ready;
    const glassMaterial = glassCompiled.material;
    glass.material = glassMaterial;

    // A grazing sun from behind the casters, toward the camera's left.
    const sun = new DirectionalLight("sun", new Vector3(0.45, -0.32, -0.83).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      const deadline = performance.now() + 15_000;
      for (;;) {
        await graph.prepare(camera);
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) return read();
        if (performance.now() > deadline) throw new Error("The view did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const reads = () => /^#define HAPTIC_SCREEN_SHADOWS$/m.test(compiled.material.getEffect()?.defines ?? "");
    // A settings change swaps in the new variant once it has compiled; until then the previous one draws.
    const settle = async (expected = reads()) => {
      for (let frame = 0; frame < 8 || (reads() !== expected && frame < 240); frame++) await draw();
      const generator = sun.getShadowGenerator() as CascadedShadowGenerator | null;
      for (let frame = 0; frame < 60 && generator?.getDarkness() !== 0; frame++) await draw();
    };
    const captures: Capture[] = [];
    const planned: Array<[string, string | null, string[]]> = [];
    const capture = async (name: string) => {
      captures.push({ name, pixels: await draw(), screenShadows: reads() });
      planned.push([name, sceneRenderingSettings(scene).effectsPlan?.screenShadows ?? null, [
        ...graph.taskNames(), `unsupported:${spatialEffectsUnsupported(scene) ?? "no"}`, `mode:${compiled.material.transparencyMode}`,
        ...((floor.subMeshes[0] as unknown as { _drawWrappers: ({ effect?: { defines: string } } | undefined)[] })._drawWrappers ?? [])
          .map((wrapper, index) => `${index}:${/HAPTIC_SCREEN_SHADOWS/.test(wrapper?.effect?.defines ?? "")}:${/HAPTIC_CEL/.test(wrapper?.effect?.defines ?? "")}`),
      ]]);
    };
    await settle();
    await capture("off");
    settings("pbr", "high");
    await settle(true);
    await capture("high");
    // Lights change without compiling: the sun moves, stops and starts casting.
    const effects = () => Object.keys((engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects).length;
    const before = effects();
    sun.direction = new Vector3(0.47, -0.3, -0.83).normalize();
    await draw();
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: false, range: 40, outerAngle: 70, innerAngle: 40 });
    await draw();
    await capture("high, sun unshadowed");
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });
    sun.direction = new Vector3(0.45, -0.32, -0.83).normalize();
    await settle();
    const lightCompiles = Object.keys((engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects).slice(before)
      .map((key) => key.replace(/\s+/g, " ").slice(0, 160));
    await capture("high again");
    settings("cel", "off");
    await settle(false);
    await capture("cel off");
    settings("cel", "high");
    await settle();
    await capture("cel high");

    const reach = SCREEN_SHADOW_LEVELS.high.length;
    const mask = surfaceMask(scene, camera, canvas, engine.isWebGPU, floor, ramp, glass, casters, sun.direction.normalizeToNew().scaleInPlace(-1), reach);
    graph.dispose();
    return {
      width: canvas.width, height: canvas.height, captures, mask, lightCompiles, planned,
      fade: { start: SCREEN_SHADOW_LEVELS.high.fadeStart, end: SCREEN_SHADOW_LEVELS.high.fadeEnd },
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

/**
 * Per pixel, in readPixels' rows (WebGL2's bottom-up, WebGPU's top-down): the surface the view hits first (the glass's
 * pixels report the floor seen through it as "glass"), whether a caster blocks the sun within `reach` of that point
 * (`contact`) or at no distance at all (`open`), and its eye distance.
 */
function surfaceMask(
  scene: Scene, camera: FreeCamera, canvas: HTMLCanvasElement, topDown: boolean, floor: AbstractMesh, ramp: AbstractMesh,
  glass: AbstractMesh, casters: AbstractMesh[], toSun: Vector3, reach: number,
): Mask {
  const mask: Mask = { surface: [], contact: [], open: [], distance: [] };
  const solid = (mesh: AbstractMesh) => mesh === floor || casters.includes(mesh);
  for (let row = 0; row < canvas.height; row++) {
    const y = topDown ? row + 0.5 : canvas.height - row - 0.5;
    for (let column = 0; column < canvas.width; column++) {
      const ray = scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera);
      const throughGlass = scene.pickWithRay(ray, (mesh) => mesh === glass || solid(mesh));
      const hit = scene.pickWithRay(ray, solid);
      const point = hit?.pickedPoint;
      const surface = hit?.pickedMesh === floor ? "floor" : hit?.pickedMesh === ramp ? "ramp" : "other";
      mask.surface.push(throughGlass?.pickedMesh === glass && surface === "floor" ? "glass" : surface);
      mask.distance.push(point ? Vector3.Distance(point, camera.globalPosition) : Infinity);
      if (!point || surface === "other") {
        mask.contact.push(false);
        mask.open.push(false);
        continue;
      }
      const start = point.add(toSun.scale(0.002));
      const blocker = (length: number) =>
        scene.pickWithRay(new Ray(start, toSun, length), (mesh) => casters.includes(mesh) && mesh !== hit!.pickedMesh)?.hit === true;
      mask.contact.push(blocker(reach));
      mask.open.push(!blocker(100));
    }
  }
  return mask;
}
