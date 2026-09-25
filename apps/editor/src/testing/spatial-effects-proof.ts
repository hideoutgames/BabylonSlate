import {
  Camera, Color3, Color4, DirectionalLight, Engine, FreeCamera, MeshBuilder,
  PBRMaterial, PointLight, Scene, SpotLight, Vector3,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings, normalizeShadowSettings } from "@babylonslate/core";
import { applyAuthoredLightProperties, createAppWebGpuEngine, MaterialLibrary, setSceneRenderSettings } from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

/** Actual numeric pixels from authored materials and scene lights, without editor chrome. */
export async function runSpatialEffectsProof(backend: "webgl2" | "webgpu", kind: "reflections" | "point" | "spot" | "sun") {
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(96, 72);
  const captures = [];
  try {
    for (const path of ["frameGraph", "classic"] as const) {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const library = new MaterialLibrary();
      const camera = new FreeCamera("Spatial Camera", new Vector3(0, 2.5, -6), scene);
      camera.minZ = 0.1; camera.maxZ = 30;
      camera.setTarget(new Vector3(0, 0.6, 0));
      scene.activeCamera = camera;
      if (path === "classic") scene.activeCameras = [camera];
      const black = new PBRMaterial("Unlit Black", scene);
      black.unlit = true; black.albedoColor = Color3.Black();
      const floor = MeshBuilder.CreateGround("Floor", { width: 20, height: 20 }, scene);
      floor.material = black;
      let light: DirectionalLight | SpotLight | PointLight | undefined;
      if (kind === "reflections") {
        const document = createDefaultMaterialDocument("Authored Mirror");
        document.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.9, 0.9, 0.9];
        Object.assign(document.nodes.find((node) => node.id === "output")!.properties, { "default:metallic": [1], "default:roughness": [0.05] });
        const compiled = library.acquire(scene, "mirror", document);
        if (!compiled.ok || (await compiled.ready).some((d) => d.severity === "error")) throw new Error("Mirror compilation failed");
        floor.material = compiled.material;
        const red = new PBRMaterial("Red Reflection Subject", scene);
        red.unlit = true; red.albedoColor = new Color3(1, 0, 0);
        const box = MeshBuilder.CreateBox("Reflection Subject", { size: 1.5 }, scene);
        box.position.y = 1.3; box.material = red;
      } else {
        const position = new Vector3(0, 3, 0);
        light = kind === "point" ? new PointLight("Fog Light", position, scene)
          : kind === "spot" ? new SpotLight("Fog Light", position, Vector3.Down(), Math.PI / 2, 1, scene)
            : new DirectionalLight("Fog Light", new Vector3(0.2, -1, 0.1), scene);
        applyAuthoredLightProperties(light, { intensity: kind === "sun" ? 5 : 120, range: 12, outerAngle: 90, innerAngle: 60, castShadows: true });
        const blocker = MeshBuilder.CreateBox("Beam Occluder", { width: 2, height: 0.2, depth: 2 }, scene);
        blocker.position.y = 1.5; blocker.material = black;
      }
      const effects = normalizeRenderEffectsSettings({
        reflections: { enabled: false, maxSteps: 96, thickness: 0.3 },
        volumetricLighting: { enabled: false, steps: 32, density: 0.12, maxDistance: 12, intensity: 2, anisotropy: 0 },
      });
      const settings = () => setSceneRenderSettings(scene, { mode: "pbr", effects, shadows: normalizeShadowSettings({ mapSize: 256, localMapSize: 256, cascades: 2, maxLocalLights: 1, distance: 20 }) });
      settings();
      const graph = new ForwardSceneFrameGraph(scene);
      const draw = async () => {
        settings();
        const prepared = await graph.prepare(camera);
        if (prepared.path !== path) throw new Error(`Expected ${path}: ${JSON.stringify(prepared)}`);
        const deadline = performance.now() + 15_000;
        while (!graph.readiness(camera).ready) {
          if (performance.now() > deadline) throw new Error("Spatial readiness timed out");
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
        }
        // Warm the native prepass and updated shadow map before readback.
        for (let presented = 0; presented < 2;) {
          engine.beginFrame();
          let rendered = false;
          try {
            const result = graph.render(camera, false);
            rendered = result.rendered !== false;
          } finally { engine.endFrame(); }
          if (rendered) presented++;
          else {
            if (performance.now() > deadline) throw new Error("Spatial presentation timed out");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
            await graph.prepare(camera);
          }
        }
        const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
        const result = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
        if (backend === "webgpu" && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
          for (let i = 0; i < result.length; i += 4) [result[i], result[i + 2]] = [result[i + 2]!, result[i]!];
        return result;
      };
      try {
        const off = await draw();
        if (kind === "reflections") effects.reflections.enabled = true;
        else effects.volumetricLighting.enabled = true;
        const on = await draw();
        let changed: number[];
        if (light) { applyAuthoredLightProperties(light, { castShadows: false }); changed = await draw(); }
        else {
          camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
          camera.orthoLeft = -4; camera.orthoRight = 4; camera.orthoTop = 3; camera.orthoBottom = -3;
          changed = await draw();
          camera.mode = Camera.PERSPECTIVE_CAMERA;
        }
        effects.reflections.enabled = effects.volumetricLighting.enabled = false;
        const disabled = await draw();
        captures.push({ path, off, on, changed, disabled });
      } finally {
        graph.dispose(); await graph.whenReleased();
        library.dispose(); scene.dispose();
      }
    }
    return { captures, reservations: managedRenderReservations(engine) };
  } finally { engine.dispose(); canvas.remove(); }
}
