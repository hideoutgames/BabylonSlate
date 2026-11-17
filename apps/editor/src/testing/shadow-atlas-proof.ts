/**
 * Test-build-only proof of the shadow atlas's sampling: one fixed frame through the Forward FrameGraph, a lit graph
 * Material under a shadowed sun (four cascades over the visible ground), a shadowed spot light and a shadowed point
 * light, with volumetric lighting marching all three, at the highest filter quality with PCF and then with Contact
 * Hardening. Each capture is the presented frame's bytes, so two builds' frames can be compared byte for byte, and each
 * map's tiles, so a capture shows that every map drew.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  normalizeCelShadingSettings,
  normalizeRenderEffectsSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";

export type ShadowAtlasCapture = {
  filter: "pcf" | "pcss";
  width: number;
  height: number;
  /** The presented frame, RGBA bytes from the bottom row up. */
  frame: number[];
  /** Per shadowed light, its map's tile sizes (one per cascade or face), and the sun's cascade ends as drawn. */
  maps: { light: string; tiles: number[] }[];
  cascadeEnds: number[];
};

export async function runShadowAtlasProof() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(canvas.width, canvas.height);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 3.5, -8), scene);
    camera.setTarget(new Vector3(0, 0, 12));
    camera.minZ = 0.1;
    camera.maxZ = 120;
    scene.activeCamera = camera;
    const settings = (filter: "pcf" | "pcss") => setSceneRenderSettings(scene, {
      mode: "pbr",
      effects: normalizeRenderEffectsSettings({
        ambientOcclusion: { enabled: false },
        reflections: { enabled: false },
        volumetricLighting: { enabled: true, steps: 16, maxLights: 4, density: 0.04, maxDistance: 30, intensity: 1 },
      }),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
      shadows: normalizeShadowSettings({
        profile: "high", cascades: 4, mapSize: 1024, localMapSize: 1024, maxLocalLights: 4, distance: 40, filter,
        filterQuality: "high", softness: 0.05, screenShadows: "off", reflections: false,
      }),
    });
    settings("pcf");

    const doc = createDefaultMaterialDocument("lit");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.7];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("the Material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "lit" });
    if (!compiled.ok) throw new Error("the Material did not compile");
    await compiled.ready;
    const lit = compiled.material;

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 90 }, scene);
    ground.position.z = 35;
    ground.material = lit;
    // Casters along the view, one or more in each cascade's slice.
    [[-1.5, 0], [1.5, 3], [-2, 7], [2.5, 12], [-3, 20], [3, 30], [0, 38]].forEach(([x, z], index) => {
      const box = MeshBuilder.CreateBox(`box${index}`, { width: 1 + z! / 20, height: 1.5 + z! / 15, depth: 1 + z! / 20 }, scene);
      box.position.set(x!, (1.5 + z! / 15) / 2, z!);
      box.rotation.y = 0.3 * index;
      box.material = lit;
    });
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 0.9, segments: 16 }, scene);
    ball.position.set(-3, 1.2, 4);
    ball.material = lit;
    const post = MeshBuilder.CreateCylinder("post", { diameter: 0.4, height: 1.4, tessellation: 16 }, scene);
    post.position.set(3.5, 0.7, 7);
    post.material = lit;

    const sun = new DirectionalLight("sun", new Vector3(0.4, -0.7, 0.5).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true });
    const spot = new SpotLight("spot", new Vector3(-3, 4, 3.5), new Vector3(0, -1, 0.15), Math.PI / 2, 2, scene);
    applyAuthoredLightProperties(spot, { color: [1, 0.6, 0.4], intensity: 30, castShadows: true, range: 12, outerAngle: 70, innerAngle: 40 });
    const lamp = new PointLight("lamp", new Vector3(3.5, 2.4, 6), scene);
    applyAuthoredLightProperties(lamp, { color: [0.5, 0.7, 1], intensity: 20, castShadows: true, range: 9 });

    const graph = new ForwardSceneFrameGraph(scene);
    const capture = async (filter: "pcf" | "pcss"): Promise<ShadowAtlasCapture> => {
      settings(filter);
      const deadline = performance.now() + 30_000;
      await graph.prepare(camera);
      while (!graph.readiness(camera).ready) {
        if (performance.now() > deadline) throw new Error(`${filter}: readiness timed out`);
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
      // The maps draw on the first frames; the last one is the capture.
      for (let presented = 0; presented < 8;) {
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) presented++;
        else {
          if (performance.now() > deadline) throw new Error(`${filter}: presentation timed out`);
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
          await graph.prepare(camera);
        }
      }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      const tiles = (generator: unknown) =>
        ((generator as unknown as { tiles?: { size: number }[] } | null)?.tiles ?? []).map((tile) => tile.size);
      return {
        filter,
        width: canvas.width,
        height: canvas.height,
        frame: Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)),
        maps: [sun, spot, lamp].map((light) => ({ light: light.name, tiles: tiles(light.getShadowGenerator()) })),
        cascadeEnds: [...((sun.getShadowGenerator() as unknown as { cascadeEnds?: number[] } | null)?.cascadeEnds ?? [])],
      };
    };
    const captures = [await capture("pcf"), await capture("pcss")];
    graph.dispose();
    await graph.whenReleased();
    return { captures, renderer: engine.getGlInfo().renderer };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
