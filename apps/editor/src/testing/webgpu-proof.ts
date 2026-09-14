/** Test-build-only WebGPU capability and native shader proof. */
import {
  Color3,
  Color4,
  EngineStore,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
  Vector3,
  type AbstractEngine,
} from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  compileMaterialPlan,
  createAppEngine,
  createAppWebGpuEngine,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
  setSceneRenderSettings,
} from "@babylonslate/render";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

export async function runWebGpuProof() {
  const initialEngines = EngineStore.Instances.length;
  const captures = [];
  const previews = [];
  let cancelledEngineReleased = false;
  for (const backend of ["webgl2", "webgpu"] as const) {
    if (backend === "webgpu" && !(await WebGPUEngine.IsSupportedAsync))
      throw new Error("The local browser did not provide a WebGPU adapter.");
    if (backend === "webgpu") {
      const pendingCanvas = document.createElement("canvas");
      const controller = new AbortController();
      const reason = new Error("Superseded during device initialization");
      const before = EngineStore.Instances.length;
      const pending = createAppWebGpuEngine(
        pendingCanvas,
        {},
        controller.signal,
      );
      controller.abort(reason);
      try {
        await pending;
        throw new Error("Cancelled Engine was published");
      } catch (error) {
        if (error !== reason) throw error;
      }
      cancelledEngineReleased = EngineStore.Instances.length === before;
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    document.getElementById("root")!.append(canvas);
    const swapChainFormat =
      backend === "webgpu"
        ? (
            navigator as unknown as {
              gpu: { getPreferredCanvasFormat(): "rgba8unorm" | "bgra8unorm" };
            }
          ).gpu.getPreferredCanvasFormat()
        : null;
    const engine =
      backend === "webgpu"
        ? await createAppWebGpuEngine(canvas)
        : createAppEngine(canvas);
    try {
      for (const mode of ["pbr", "cel"] as const) {
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0, 0, 0, 1);
        const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
        camera.setTarget(Vector3.Zero());
        const light = new HemisphericLight("light", Vector3.Up(), scene);
        light.intensity = 1;
        const source = new PBRMaterial("Native", scene);
        source.metallic = 0;
        source.roughness = 1;
        source.albedoColor = new Color3(0.04, 0.6, 0.12);
        source.albedoTexture = RawTexture.CreateRGBATexture(
          new Uint8Array([
            255, 255, 255, 255, 255, 255, 255, 255, 128, 128, 128, 255, 128,
            128, 128, 255,
          ]),
          2,
          2,
          scene,
          false,
          false,
          Texture.NEAREST_SAMPLINGMODE,
        );
        const native = MeshBuilder.CreatePlane("Native", { size: 1.5 }, scene);
        native.position.x = -0.85;
        native.material = source;
        setSceneRenderSettings(scene, { mode });
        const document = createDefaultMaterialDocument("Graph");
        document.nodes.find(
          (node) => node.id === "baseColor",
        )!.properties.value = [0.04, 0.6, 0.12];
        const lowered = lowerMaterialDocument(document);
        if (!lowered.ok) throw new Error("WebGPU proof material did not lower");
        const compiled = compileMaterialPlan(lowered.plan, {
          scene,
          name: "Graph",
        });
        if (compiled.ok === false)
          throw new Error(JSON.stringify(compiled.diagnostics));
        const diagnostics = await compiled.ready;
        if (diagnostics.some((entry) => entry.severity === "error"))
          throw new Error(JSON.stringify(diagnostics));
        const graph = MeshBuilder.CreatePlane("Graph", { size: 1.5 }, scene);
        graph.position.x = 0.85;
        graph.material = compiled.material;
        await native.material!.forceCompilationAsync(native);
        await compiled.material.forceCompilationAsync(graph);
        for (let frame = 0; frame < 3; frame++) {
          engine.beginFrame();
          scene.render(false);
          engine.endFrame();
        }
        const readback = await engine.readPixels(0, 0, 64, 64);
        captures.push({
          backend,
          mode,
          info:
            engine instanceof WebGPUEngine
              ? engine.getInfo()
              : engine.getGlInfo(),
          shaderLanguage: compiled.material.shaderLanguage,
          pixelFormat: swapChainFormat ?? "rgba8unorm",
          pixelOrigin: backend === "webgpu" ? "top-left" : "bottom-left",
          pixels: [
            ...new Uint8Array(
              readback.buffer,
              readback.byteOffset,
              readback.byteLength,
            ),
          ],
          maxTextureSize: engine.getCaps().maxTextureSize,
        });
        compiled.dispose();
        scene.dispose();
        previews.push({
          backend,
          mode,
          pixels: await capturePreview(engine, mode),
        });
      }
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }
  return {
    captures,
    previews,
    cancelledEngineReleased,
    retainedEngines: EngineStore.Instances.length - initialEngines,
  };
}

async function capturePreview(engine: AbstractEngine, mode: "pbr" | "cel") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  canvas.style.width = canvas.style.height = "64px";
  document.getElementById("root")!.append(canvas);
  const host = createMaterialPreviewScene(engine, { mesh: "plane" });
  host.camera.setPosition(new Vector3(0, 0, -4));
  host.camera.setTarget(Vector3.Zero());
  const material = new PBRMaterial("preview numeric texture", host.scene);
  material.metallic = 0;
  material.roughness = 1;
  material.albedoColor = new Color3(0.04, 0.6, 0.12);
  material.albedoTexture = RawTexture.CreateRGBATexture(
    new Uint8Array([
      255, 255, 255, 255, 255, 255, 255, 255, 128, 128, 128, 255, 128, 128, 128,
      255,
    ]),
    2,
    2,
    host.scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  host.applyMaterial(material);
  setSceneRenderSettings(host.scene, { mode });
  let failure: string | null = null;
  const presenter = createMaterialPreviewPresenter(host, canvas, {
    onError: (message) => {
      failure = message;
    },
  });
  try {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      engine.beginFrame();
      presenter.present({ force: true });
      engine.endFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      if (failure) throw new Error(failure);
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, 64, 64).data;
      if (pixels[(32 * 64 + 32) * 4 + 1] > 30) return [...pixels];
    }
    throw new Error("Material preview did not present its GPU readback.");
  } finally {
    presenter.dispose();
    host.dispose();
    canvas.remove();
  }
}
