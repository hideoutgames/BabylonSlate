/**
 * Test-build-only proof of Large World Rendering (`RenderProjectSettings.largeWorldRendering`): one fixed frame through
 * the Forward FrameGraph of a lit scene placed at `origin`, on an Engine built with the project's Engine options for the
 * mode (`largeWorldEngineOptions`). The scene holds rough, glossy, alpha-clipped, translucent and instanced graph
 * Materials, the unlit Material lit in 3D, a shadowed sun, clustered point and spot lights, ambient occlusion,
 * Real-Time Reflections, volumetric lighting and Screen-Space Shadows; the camera stands metres off `origin` and looks
 * down and across it, so nothing relies on the eye sitting at the world origin. The spec compares the frame near the
 * origin with the mode off and on, and kilometres out with it on (and off, as the control that jitters).
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
import { applyAuthoredLightProperties, compileMaterialPlan, largeWorldEngineOptions, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey, type MaterialBlendMode } from "@haptic/shader-graph";
import { allowSceneScreenShadows } from "../../../../packages/render/src/render-settings";
import { setUnlitMaterial } from "../../../../packages/render/src/unlit-material";

export const LARGE_WORLD_PROOF_SIZE = { width: 320, height: 200 } as const;

export type LargeWorldProofOptions = {
  largeWorld: boolean;
  /** Where the scene stands: every mesh, light and the camera are placed relative to it. */
  origin: [number, number, number];
};

export async function runLargeWorldProof(options: LargeWorldProofOptions) {
  const canvas = document.createElement("canvas");
  canvas.width = LARGE_WORLD_PROOF_SIZE.width;
  canvas.height = LARGE_WORLD_PROOF_SIZE.height;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, ...largeWorldEngineOptions(options.largeWorld) });
  engine.setSize(canvas.width, canvas.height);
  const scene = new Scene(engine);
  const [ox, oy, oz] = options.origin;
  const at = (x: number, y: number, z: number) => new Vector3(ox + x, oy + y, oz + z);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", at(3.2, 2.6, -5.5), scene);
    camera.setTarget(at(-0.6, 0.4, 2));
    camera.minZ = 0.1;
    camera.maxZ = 60;
    scene.activeCamera = camera;
    allowSceneScreenShadows(scene, () => true);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      effects: normalizeRenderEffectsSettings({
        ambientOcclusion: { enabled: true, resolutionScale: 0.5, radius: 0.6, strength: 2 },
        reflections: { enabled: true, maxSteps: 64, thickness: 0.3 },
        volumetricLighting: { enabled: true, steps: 16, density: 0.04, maxDistance: 20, intensity: 1 },
      }),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
      shadows: normalizeShadowSettings({ cascades: 2, mapSize: 512, distance: 30, screenShadows: "high" }),
    });

    const material = async (name: string, color: number[], metallic: number, roughness: number, blendMode: MaterialBlendMode = "opaque", opacity = 1) => {
      const doc = createDefaultMaterialDocument(name);
      doc.blendMode = blendMode;
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [roughness];
      if (blendMode !== "opaque") output[materialPinDefaultPropertyKey("opacity")] = [opacity];
      const lowered = lowerMaterialDocument(doc);
      if (!lowered.ok) throw new Error(`${name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name });
      if (!compiled.ok) throw new Error(`${name} did not compile`);
      await compiled.ready;
      return compiled.material;
    };
    const rough = await material("rough", [0.8, 0.8, 0.8], 0, 0.7);
    const glossy = await material("glossy", [0.9, 0.85, 0.7], 1, 0.15);
    const clipped = await material("clipped", [0.3, 0.7, 0.3], 0, 0.4, "masked", 0.8);
    const glass = await material("glass", [0.6, 0.8, 1], 0, 0.1, "translucent", 0.3);

    const floor = MeshBuilder.CreateGround("floor", { width: 14, height: 30 }, scene);
    floor.position = at(0, 0, 9);
    floor.material = glossy;
    const wall = MeshBuilder.CreateBox("wall", { width: 10, height: 3, depth: 0.3 }, scene);
    wall.position = at(0, 1.5, 7);
    wall.material = rough;
    const box = MeshBuilder.CreateBox("box", { size: 0.8 }, scene);
    box.position = at(-1.4, 0.4, 0.8);
    box.rotation.y = 0.4;
    box.material = rough;
    // Instances share the box's draw: their rows hold each placement as the floating origin uploads it.
    for (let index = 0; index < 6; index++) {
      const instance = box.createInstance(`crate ${index}`);
      instance.position = at(-3 + index * 1.1, 0.25, 4 + (index % 2) * 0.9);
      instance.rotation.y = index * 0.37;
      instance.scaling.setAll(0.6);
    }
    const leaf = MeshBuilder.CreateBox("leaf", { width: 1, height: 1.2, depth: 0.1 }, scene);
    leaf.position = at(1.4, 0.6, 1.2);
    leaf.material = clipped;
    const pane = MeshBuilder.CreatePlane("pane", { width: 1, height: 0.7 }, scene);
    pane.position = at(-0.2, 0.5, -0.4);
    pane.material = glass;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.1, segments: 24 }, scene);
    ball.position = at(1.8, 0.55, 3);
    ball.material = glossy;
    const pillar = MeshBuilder.CreateCylinder("pillar", { diameter: 0.5, height: 1.6, tessellation: 16 }, scene);
    pillar.position = at(0.2, 0.8, 2.4);
    setUnlitMaterial(pillar, { textured: false, backFaceCulling: true, fog: true, role: "world", lighting: "3d" }, {
      texture: null, color: [0.9, 0.4, 0.2], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
    });

    const sun = new DirectionalLight("sun", new Vector3(0.45, -0.5, 0.6).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });
    const lamps: [number, number, number, number[]][] = [[1, 2, 0, [0.6, 0.7, 1]], [-2.5, 1.2, 3, [1, 0.5, 0.3]], [2.5, 1, 5, [0.4, 1, 0.5]]];
    for (const [x, y, z, color] of lamps) {
      const lamp = new PointLight(`lamp ${x}`, at(x, y, z), scene);
      applyAuthoredLightProperties(lamp, { color, intensity: 8, castShadows: false, range: 6, outerAngle: 70, innerAngle: 40 });
    }
    const spot = new SpotLight("spot", at(-1, 3, 1), new Vector3(0.2, -1, 0.3).normalize(), Math.PI / 3, 2, scene);
    applyAuthoredLightProperties(spot, { color: [1, 0.9, 0.6], intensity: 10, castShadows: true, range: 8, outerAngle: 60, innerAngle: 35 });

    const graph = new ForwardSceneFrameGraph(scene);
    const deadline = performance.now() + 30_000;
    await graph.prepare(camera);
    while (!graph.readiness(camera).ready) {
      if (performance.now() > deadline) throw new Error("readiness timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      await graph.prepare(camera);
    }
    // Shadow maps, the screen shadows and the temporal effects settle over the first frames; the last one is the capture.
    for (let presented = 0; presented < 8;) {
      engine.beginFrame();
      let rendered: boolean;
      try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
      if (rendered) presented++;
      else {
        if (performance.now() > deadline) throw new Error("presentation timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
    }
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    const frame = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    const floatingOrigin = scene.floatingOriginMode;
    graph.dispose();
    await graph.whenReleased();
    return { frame, floatingOrigin, renderer: engine.getGlInfo().renderer };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
