/**
 * Test-build-only differential oracle for fixed-shape forward lighting: the
 * same Scene and light set drawn by the legacy path and by fixed seats (each
 * seat guard), on the real GPU, through the Forward FrameGraph.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
  type AbstractEngine,
  type Effect,
  type Light,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import {
  fixedLightSlotTable,
  setFixedShapeLightingEnabled,
  setFixedShapeLightingWorldScene,
} from "../../../../packages/render/src/fixed-light-admission";
import { setFixedShapeLightGuard, type FixedLightGuard } from "../../../../packages/render/src/fixed-light-binding";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Path = "legacy" | FixedLightGuard;
const PATHS: readonly Path[] = ["legacy", "multiply", "branch"];

/** Lit Effects (any light define) the Engine holds, by key. */
function litEffectKeys(engine: AbstractEngine): string[] {
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  return Object.keys(effects).filter((key) => /#define LIGHT0\b/.test(effects[key]!.defines)).sort();
}

export async function runFixedLightProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  // Bundled snapshots replay without Light._bindLight; light membership changes between captures.
  if (engine.isWebGPU) engine.snapshotRendering = false;
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 4.5, -7.5), scene);
    camera.setTarget(new Vector3(0, 0.4, 0));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    setFixedShapeLightingWorldScene(scene);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 2 }),
    });
    const pbr = new PBRMaterial("native pbr", scene);
    pbr.albedoColor = new Color3(0.8, 0.8, 0.8);
    pbr.metallic = 0;
    pbr.roughness = 0.55;
    const standard = new StandardMaterial("native standard", scene);
    standard.diffuseColor = new Color3(0.8, 0.8, 0.8);
    standard.specularColor = new Color3(0.4, 0.4, 0.4);
    for (const [index, material] of [pbr, standard].entries()) {
      const floor = MeshBuilder.CreateGround(`floor-${index}`, { width: 4, height: 6 }, scene);
      floor.position.x = index ? 2.1 : -2.1;
      floor.material = material;
      floor.receiveShadows = true;
      const box = MeshBuilder.CreateBox(`box-${index}`, { size: 1 }, scene);
      box.position.set(index ? 2.1 : -2.1, 0.5, 0.6);
      box.material = material;
      box.receiveShadows = true;
    }
    const authored = (light: Light, color: number[], intensity: number, castShadows = false) =>
      applyAuthoredLightProperties(light, { color, intensity, castShadows, range: 9, outerAngle: 70, innerAngle: 40 });
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
    authored(sun, [1, 0.95, 0.85], 0.7);
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    authored(fill, [0.3, 0.35, 0.5], 0.35);
    // The first spot casts: it holds a spot shadow seat, whose shadow still follows its light.
    const spots = [[-2.6, 3, -0.5], [2.4, 3, 1.2]].map(([x, y, z], index) => {
      const light = new SpotLight(`spot-${index}`, new Vector3(x, y, z), new Vector3(0.1, -1, 0.15), 1, 2, scene);
      authored(light, index ? [0.2, 0.9, 0.3] : [0.9, 0.3, 0.2], 1.4, index === 0);
      return light;
    });
    const points = [[-0.6, 1.6, -1.2], [1.4, 1.2, -1.5], [0, 1.8, 1.8]].map(([x, y, z], index) => {
      const light = new PointLight(`point-${index}`, new Vector3(x, y, z), scene);
      authored(light, [[0.3, 0.4, 1], [1, 0.8, 0.2], [0.8, 0.3, 0.9]][index]!, 0.9);
      return light;
    });
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      // Twice: the first frame draws the render-once shadow map.
      for (let frame = 0; frame < 2; frame++) {
        engine.beginFrame();
        try { graph.render(camera, false); } finally { engine.endFrame(); }
      }
      return read();
    };
    const selectPath = (path: Path) => {
      if (path !== "legacy") setFixedShapeLightGuard(engine, path);
      setFixedShapeLightingEnabled(engine, path !== "legacy");
    };
    const poses: { name: string; apply: () => void }[] = [
      { name: "all lights", apply: () => undefined },
      // Seats of a disabled light stay in the layout, empty.
      { name: "empty seats", apply: () => { setAuthoredLightEnabled(points[1]!, false); setAuthoredLightEnabled(spots[1]!, false); } },
      { name: "sun only", apply: () => { for (const light of [fill, ...spots, ...points]) setAuthoredLightEnabled(light, false); } },
    ];
    const restore = () => { for (const light of [sun, fill, ...spots, ...points]) setAuthoredLightEnabled(light, true); };
    const captures: { name: string; path: Path; pixels: number[] }[] = [];
    const seats: Record<string, (string | null)[]> = {};
    for (const path of PATHS) {
      selectPath(path);
      for (const pose of poses) {
        restore();
        pose.apply();
        captures.push({ name: pose.name, path, pixels: await draw() });
        if (path !== "legacy" && pose.name === "all lights")
          seats[path] = fixedLightSlotTable(scene)?.seats.map((seat) => `${seat.classId}:${seat.light?.name ?? "-"}${seat.shadowActive ? " shadowed" : ""}`) ?? [];
      }
    }

    // Toggles and seat changes on the fixed path compile nothing new.
    selectPath("multiply");
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
    await step("an unshadowed spot switched off", () => setAuthoredLightEnabled(spots[1]!, false));
    await step("the fill switched off", () => setAuthoredLightEnabled(fill, false));
    await step("all back on", restore);
    await step("a new point in a freed seat", () => {
      points[0]!.dispose();
      const light = new PointLight("replacement", new Vector3(0.6, 1.5, -0.4), scene);
      authored(light, [0.3, 1, 0.9], 0.9);
    });
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    const fixedLitEffects = litEffectKeys(engine).filter((key) => effects[key]!.defines.includes("#define SLATE_FIXED_LIGHTS\n")).length;
    graph.dispose();
    return { backend, width: canvas.width, height: canvas.height, captures, seats, steps, fixedLitEffects };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
