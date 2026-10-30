/**
 * Test-build-only oracle for the sun's cascade split: a floor and boxes from 2 m to 30 m under the sun at Medium shadow
 * quality, with a 1000 m camera range so the split is the log split anchored at 4 m. The camera slides 1 cm a frame for
 * 30 frames; each frame the drawn shadow is classified per floor pixel and compared with a ray-cast mask of what
 * blocks the floor's view of the sun.
 */
import {
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  Scene,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type CascadedShadowGenerator,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import type { AtlasCascadedShadowGenerator } from "../../../../packages/render/src/shadow-atlas";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";
import { floorShadowMask } from "./haptic-contact-shadow-proof";

/** Per floor pixel: 1 drawn in shadow (under half the sun's light), 0 lit, -1 off the floor. */
type Frame = { drawn: number[]; blocked: number[] };

export async function runCascadeShimmerProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 100;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 2.2, -4), scene);
    camera.setTarget(new Vector3(0, 0, 8));
    camera.minZ = 0.1;
    camera.maxZ = 1000;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({}),
      // Medium's three cascades over 250 m, biased past the acne a slanting sun shows on the floor.
      shadows: normalizeShadowSettings({ profile: "medium", depthBias: 0.0008 }),
    });

    const doc = createDefaultMaterialDocument("rough dielectric");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.6];
    output[materialPinDefaultPropertyKey("environmentInfluence")] = [0];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("The surface did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "rough dielectric" });
    if (!compiled.ok) throw new Error("The surface did not compile");
    await compiled.ready;

    const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 50 }, scene);
    floor.position.z = 20;
    const meshes: AbstractMesh[] = [floor];
    // Boxes in the first cascade (to 15.9 m) and the second.
    for (const [x, z, size] of [[-1.2, 2, 0.8], [1.5, 6, 1.2], [-2.5, 11, 1.6], [3, 20, 2.4], [-4, 30, 3]] as const) {
      const box = MeshBuilder.CreateBox(`box ${z}`, { size }, scene);
      box.position.set(x, size / 2, z);
      box.rotation.y = 0.5;
      meshes.push(box);
    }
    for (const mesh of meshes) mesh.material = compiled.material;
    const sun = new DirectionalLight("sun", new Vector3(-0.45, -0.8, 0.4), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      return read();
    };
    await draw();
    const generator = sun.getShadowGenerator() as CascadedShadowGenerator | null;
    for (let frame = 0; frame < 60 && generator?.getDarkness() !== 0; frame++) await draw();

    const toSun = () => sun.direction.normalizeToNew().scaleInPlace(-100);
    const frames: Frame[] = [];
    for (let frame = 0; frame < 30; frame++) {
      camera.position.x += 0.01;
      const drawn = await draw();
      sun.shadowEnabled = false;
      const open = await draw();
      sun.shadowEnabled = true;
      setAuthoredLightEnabled(sun, false);
      const unlit = await draw();
      setAuthoredLightEnabled(sun, true);
      const blocked = floorShadowMask(scene, camera, canvas, engine.isWebGPU, meshes, toSun);
      frames.push({
        blocked,
        drawn: blocked.map((kind, pixel) => {
          if (kind < 0) return -1;
          let share = 1;
          for (let channel = 0; channel < 3; channel++) {
            const index = pixel * 4 + channel, full = open[index]! - unlit[index]!;
            if (full > 8) share = Math.min(share, (drawn[index]! - unlit[index]!) / full);
          }
          return share < 0.5 ? 1 : 0;
        }),
      });
    }
    // Draw the frame again so the cascades report the split they drew.
    await draw();
    const atlas = generator as unknown as AtlasCascadedShadowGenerator | null;
    graph.dispose();
    return { width: canvas.width, height: canvas.height, frames, lambda: generator?.lambda ?? null, cascades: atlas?.cascadeDensity ?? [] };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
