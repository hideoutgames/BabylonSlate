/** Actual production FrameGraph receiver qualification; only the fixture is test-only. */
import { Color3, Color4, Engine, FreeCamera, Matrix, MeshBuilder, PBRMaterial, PointLight, RectAreaLight, Scene, Vector3, Viewport } from "@babylonjs/core";
import { createActor, createDefaultScene, normalizeCelShadingSettings, normalizeEnvironmentLightingSettings, type RenderPath } from "@babylonslate/core";
import { beginEngineDrawCallFrame, compileMaterialPlan, createAppWebGpuEngine, readEngineDrawCalls, requestRenderPath, sceneRenderPathStatus, setSceneRenderSettings, syncAuthoredIllumination } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { qualifyAreaEmission } from "./area-emission-proof";

export async function runAreaRectLightProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  const width = canvas.width = 240, height = canvas.height = 160;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const results = [];
  const emission = await qualifyAreaEmission(engine);
  try {
    for (const mode of ["pbr", "cel"] as const) {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const camera = new FreeCamera("area receivers", new Vector3(0, 0, -6), scene);
      camera.setTarget(Vector3.Zero()); camera.minZ = 0.1; camera.maxZ = 50;
      scene.activeCamera = camera;
      const document = createDefaultScene();
      const emitter = createActor("emitter", "Rectangular Area Light", { transform: { position: [0, 0.5, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [{ id: "area", classId: "AreaRectLightComponent", properties: { width: 2, height: 2, intensity: 4 } }] });
      document.actors = [emitter];
      document.settings.environmentLighting = { enabled: false };
      const native = new PBRMaterial("native PBR receiver", scene);
      native.albedoColor = new Color3(0.55, 0.08, 0.03); native.metallic = 0; native.roughness = 0.7;
      const left = MeshBuilder.CreateSphere("native", { diameter: 1.5, segments: 24 }, scene);
      left.position.x = -0.9; left.material = native;
      const settings = { mode, cel: normalizeCelShadingSettings({ shadowBands: 3, shadowStrength: 1, specularEnabled: false }), environmentLighting: normalizeEnvironmentLightingSettings({ enabled: false }) };
      setSceneRenderSettings(scene, settings);
      const materialDocument = createDefaultMaterialDocument("graph receiver");
      materialDocument.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.05, 0.55, 0.12];
      const lower = lowerMaterialDocument(materialDocument);
      if (!lower.ok) throw new Error("Area receiver graph did not lower");
      const compiled = compileMaterialPlan(lower.plan, { scene, name: "area graph receiver" });
      if (!compiled.ok) throw new Error("Area receiver graph did not compile");
      if ((await compiled.ready).some((entry) => entry.severity === "error")) throw new Error("Area receiver shader failed");
      const right = MeshBuilder.CreateSphere("graph", { diameter: 1.5, segments: 24 }, scene);
      right.position.x = 0.9; right.material = compiled.material;
      const unlit = new PBRMaterial("unlit control", scene);
      unlit.unlit = true; unlit.albedoColor = new Color3(0.1, 0.1, 0.8);
      const control = MeshBuilder.CreateBox("unlit", { size: 0.4 }, scene);
      control.position.set(0, -1.1, 0); control.material = unlit;
      syncAuthoredIllumination(scene, document);
      // Conventional/clustered coexistence must preserve the rectangular emitter.
      const point = new PointLight("clustered candidate", new Vector3(0, 2, -1), scene);
      point.intensity = 0.1; point.range = 8;
      setSceneRenderSettings(scene, settings);
      const coordinator = new SceneRenderCoordinator(scene);
      try {
        for (const renderPath of ["forward", "clusteredForward"] as RenderPath[]) {
          requestRenderPath(engine, { renderPath });
          const capture = async (name: string) => {
            syncAuthoredIllumination(scene, document, { assets: { areaEmissions: emission.emissions } });
            coordinator.invalidate();
            await coordinator.prepare();
            for (let frame = 0; frame < 3; frame++) {
              engine.beginFrame();
              try {
              beginEngineDrawCallFrame(engine);
              const rendered = coordinator.render();
              if (!rendered.rendered || rendered.path !== "frameGraph") throw new Error(`Area light did not use the production FrameGraph: ${JSON.stringify(rendered)}`);
              } finally { engine.endFrame(); }
              if (frame < 2) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
            const copy = window.document.createElement("canvas"); copy.width = width; copy.height = height;
            const ctx = copy.getContext("2d")!;
            // The presented bitmap handles WebGPU swapchain BGRA and row order.
            ctx.drawImage(canvas, 0, 0);
            const image = ctx.getImageData(0, 0, width, height);
            const luminance = (x1: number, x2: number) => {
              let value = 0;
              for (let y = 45; y < 110; y++) for (let x = x1; x < x2; x++) { const offset = (y * width + x) * 4; value += image.data[offset]! + image.data[offset + 1]! + image.data[offset + 2]!; }
              return value;
            };
            const sample = Vector3.Project(control.position, Matrix.IdentityReadOnly, scene.getTransformMatrix(), new Viewport(0, 0, width, height));
            const offset = (Math.round(sample.y) * width + Math.round(sample.x)) * 4;
            const nativeLevels = new Set<number>();
            for (let y = 45; y < 110; y++) for (let x = 45; x < 113; x++) nativeLevels.add(image.data[(y * width + x) * 4]!);
            return { name, image: copy.toDataURL(), nativeBrightness: luminance(45, 113), graphBrightness: luminance(127, 195), nativeLevels: [...nativeLevels], unlit: Array.from(image.data.slice(offset, offset + 4)), draws: readEngineDrawCalls(engine), tasks: coordinator.taskNames() };
          };
          emitter.components[0]!.properties.enabled = true;
          emitter.transform.rotation = [0, 0, 0, 1];
          const on = await capture("enabled");
          emitter.components[0]!.properties.enabled = false;
          const off = await capture("disabled");
          emitter.components[0]!.properties.enabled = true;
          emitter.transform.rotation = [0, 1, 0, 0];
          const back = await capture("turned away");
          emitter.transform.rotation = [0, 0, 0, 1];
          const restored = await capture("restored");
          emitter.components[0]!.properties.textureGuid = "pattern";
          const textured = await capture("prepared texture");
          const light = scene.lights.find((entry) => entry instanceof RectAreaLight) as RectAreaLight;
          const preparedTexture = light.emissionTexture;
          light.emissionTexture = emission.native; light._markMeshesAsLightDirty();
          const nativeTexture = await capture("native texture oracle");
          light.emissionTexture = preparedTexture; light._markMeshesAsLightDirty();
          emitter.components[0]!.properties.textureGuid = null;
          results.push({ mode, renderPath, pipeline: sceneRenderPathStatus(scene), captures: [on, off, back, restored, textured, nativeTexture] });
        }
      } finally { coordinator.dispose(); scene.dispose(); }
    }
    return { backend, width, height, results, emission: emission.report, userAgent: navigator.userAgent, dpr: devicePixelRatio };
  } finally { emission.native.dispose(); engine.dispose(); canvas.remove(); }
}
