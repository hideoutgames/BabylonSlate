/**
 * Test-build-only differential oracle for the lighting plan's Phase 4 spike: the same PBR graph Scene drawn by
 * Babylon's per-light path and by the HapticLights loops (both light sets), on the real GPU, through the Forward
 * FrameGraph.
 */
import {
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
  type Effect,
  type Light,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { setHapticLighting, type HapticLightSet } from "../../../../packages/render/src/haptic-lights";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Path = "babylon" | HapticLightSet;
const PATHS: readonly Path[] = ["babylon", "forward", "all"];

/** Lit Effects (Babylon's light defines or the light block) the Engine holds, by key. */
function litEffectKeys(engine: Engine): string[] {
  const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
  return Object.keys(effects).filter((key) => /#define (LIGHT0|HAPTIC_LIGHTS)\b/.test(effects[key]!.defines)).sort();
}

export async function runHapticLightProof() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
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
    const camera = new FreeCamera("camera", new Vector3(0, 4.5, -7.5), scene);
    camera.setTarget(new Vector3(0, 0.4, 0));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 0 }),
    });
    const doc = createDefaultMaterialDocument("Graph Surface");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("Surface fixture did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "Graph Surface" });
    if (!compiled.ok) throw new Error("Surface fixture did not compile");
    await compiled.ready;
    const floor = MeshBuilder.CreateGround("floor", { width: 8, height: 6 }, scene);
    floor.material = compiled.material;
    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position.set(-1.4, 0.5, 0.6);
    box.material = compiled.material;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.2, segments: 16 }, scene);
    ball.position.set(1.4, 0.6, 0.2);
    ball.material = compiled.material;
    const authored = (light: Light, color: number[], intensity: number) =>
      applyAuthoredLightProperties(light, { color, intensity, castShadows: false, range: 9, outerAngle: 70, innerAngle: 40 });
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
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      return read();
    };
    const poses: { name: string; apply: () => void }[] = [
      { name: "all lights", apply: () => undefined },
      { name: "two off", apply: () => { setAuthoredLightEnabled(points[1]!, false); setAuthoredLightEnabled(spots[1]!, false); } },
      { name: "sun only", apply: () => { for (const light of [fill, ...spots, ...points]) setAuthoredLightEnabled(light, false); } },
    ];
    const restore = () => { for (const light of [sun, fill, ...spots, ...points]) setAuthoredLightEnabled(light, true); };
    const captures: { name: string; path: Path; pixels: number[] }[] = [];
    for (const path of PATHS) {
      setHapticLighting(engine, path === "babylon" ? null : path);
      for (const pose of poses) {
        restore();
        pose.apply();
        captures.push({ name: pose.name, path, pixels: await draw() });
      }
    }

    // Lights switching, arriving and leaving on the light block compile nothing new.
    setHapticLighting(engine, "all");
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
    const hapticLitEffects = litEffectKeys(engine).filter((key) => effects[key]!.defines.includes("#define HAPTIC_LIGHTS\n")).length;
    graph.dispose();
    return { width: canvas.width, height: canvas.height, captures, steps, hapticLitEffects };
  } finally {
    setHapticLighting(engine, null);
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
