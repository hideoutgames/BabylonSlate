import { Constants, Engine, FreeCamera, MeshBuilder, PBRMaterial, Scene, Vector3 } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { MaterialLibrary, createAppWebGpuEngine, setSceneRenderSettings } from "@babylonslate/render";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

/** Numeric geometry oracle, isolated from the editor and its render scheduler. */
export async function runFrameGraphGeometryProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  const library = new MaterialLibrary();
  const captures: Array<{ material: string; buffer: string; pixel: number[] }> = [];
  try {
    engine.setSize(32, 32);
    const camera = new FreeCamera("Geometry Camera", new Vector3(0, 0, -4), scene);
    camera.minZ = 1;
    camera.maxZ = 11;
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const mesh = MeshBuilder.CreatePlane("Numeric Plane", { size: 4 }, scene);
    const native = new PBRMaterial("Native Reference", scene);
    const document = createDefaultMaterialDocument("Geometry Surface");
    const compiled = library.acquire(scene, "surface", document);
    if (compiled.ok === false) throw new Error(JSON.stringify(compiled.diagnostics));
    const diagnostics = await compiled.ready;
    if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
    for (const mode of ["native", "pbr", "cel", "pbr-return"] as const) {
      setSceneRenderSettings(scene, { mode: mode === "cel" ? "cel" : "pbr" });
      mesh.material = mode === "native" ? native : compiled.material;
      mesh.computeWorldMatrix(true);
      scene.updateTransformMatrix(true);
      for (const buffer of ["depth", "normal"] as const) {
        const graph = new FrameGraph(scene);
        try {
          const depth = graph.textureManager.createRenderTargetTexture("Geometry Z", {
            size: { width: 32, height: 32 },
            sizeIsPercentage: false,
            options: { types: [Constants.TEXTURETYPE_FLOAT], formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT], samples: 1 },
          });
          const clear = new FrameGraphClearTextureTask("Geometry Z Clear", graph);
          clear.depthTexture = depth;
          clear.clearColor = false;
          clear.clearDepth = true;
          graph.addTask(clear);
          const geometry = new FrameGraphGeometryRendererTask("Shared Geometry", graph, scene);
          geometry.camera = camera;
          geometry.objectList = { meshes: [mesh], particleSystems: [] };
          geometry.depthTexture = clear.outputDepthTexture;
          geometry.size = { width: 32, height: 32 };
          geometry.sizeIsPercentage = false;
          geometry.textureDescriptions = [
            { type: Constants.PREPASS_NORMALIZED_VIEW_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
            { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
          ];
          graph.addTask(geometry);
          const copy = new FrameGraphCopyToBackbufferColorTask("Geometry Readback", graph);
          copy.sourceTexture = buffer === "depth" ? geometry.geometryNormViewDepthTexture : geometry.geometryWorldNormalTexture;
          graph.addTask(copy);
          await graph.buildAsync(false);
          const deadline = performance.now() + 10_000;
          while (!graph.isReady()) {
            if (performance.now() > deadline) throw new Error("Geometry readiness timed out");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
          }
          engine.beginFrame();
          try { graph.execute(); } finally { engine.endFrame(); }
          const pixels = new Uint8Array((await engine.readPixels(16, 16, 1, 1)).buffer);
          const pixel = Array.from(pixels);
          if (backend === "webgpu" && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
            [pixel[0], pixel[2]] = [pixel[2]!, pixel[0]!];
          captures.push({ material: mode, buffer, pixel });
        } finally { graph.dispose(); }
      }
    }
    return { backend, captures, retainedGraphs: scene.frameGraphs.length };
  } finally {
    library.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
