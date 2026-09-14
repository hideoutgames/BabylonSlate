import { Constants, Engine, FreeCamera, MeshBuilder, PBRMaterial, Scene, Vector3 } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { LogicalGeometryTask } from "@babylonslate/render/framegraph-logical-buffers";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { MaterialLibrary, createAppWebGpuEngine, setSceneRenderSettings } from "@babylonslate/render";
import { addAuthoredPostProcessTasks } from "@babylonslate/render/framegraph-post-process";
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
      for (const buffer of ["depth", "normal", "post-depth", "post-normal"] as const) {
        const graph = new FrameGraph(scene);
        const graphDiagnostics: unknown[] = [];
        let replaceAfterBuild: (() => Promise<void>) | undefined;
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
          const geometry = new LogicalGeometryTask("Shared Geometry", graph, scene);
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
          copy.sourceTexture = buffer.endsWith("depth") ? geometry.geometryNormViewDepthTexture : geometry.geometryWorldNormalTexture;
          if (buffer.startsWith("post-")) {
            const post = createDefaultMaterialDocument("Logical Buffer", "postProcess");
            const resource = buffer === "post-depth" ? "sceneDepth" : "sceneNormal";
            post.nodes.push({ id: "buffer", type: `input.${resource}`, properties: {}, position: { x: 0, y: 0 } });
            post.edges = [
              { id: "uv-buffer", sourceNodeId: "screenUv", sourcePinId: "uv", targetNodeId: "buffer", targetPinId: "uv" },
              { id: "buffer-output", sourceNodeId: "buffer", sourcePinId: resource === "sceneDepth" ? "depth" : "normal", targetNodeId: "output", targetPinId: "color" },
            ];
            if (resource === "sceneDepth") {
              post.nodes.push({ id: "gray", type: "vector.combine", properties: {}, position: { x: 0, y: 0 } });
              post.edges.splice(1, 1,
                ...["x", "y", "z"].map((channel) => ({ id: `depth-${channel}`, sourceNodeId: "buffer", sourcePinId: "depth", targetNodeId: "gray", targetPinId: channel })),
                { id: "gray-output", sourceNodeId: "gray", sourcePinId: "xyzw", targetNodeId: "output", targetPinId: "color" },
              );
            } else {
              post.nodes.push(
                { id: "split", type: "vector.split", properties: {}, position: { x: 0, y: 0 } },
                { id: "normalColor", type: "vector.combine", properties: {}, position: { x: 0, y: 0 } },
              );
              post.edges.splice(1, 1,
                { id: "normal-split", sourceNodeId: "buffer", sourcePinId: "normal", targetNodeId: "split", targetPinId: "value" },
                ...["x", "y", "z"].map((channel) => ({ id: `normal-${channel}`, sourceNodeId: "split", sourcePinId: channel, targetNodeId: "normalColor", targetPinId: channel })),
                { id: "normal-output", sourceNodeId: "normalColor", sourcePinId: "xyzw", targetNodeId: "output", targetPinId: "color" },
              );
            }
            const stack = addAuthoredPostProcessTasks({
              // Opposite buffer makes a silent scene-color passthrough fail the oracle.
              frameGraph: graph, library, sourceTexture: resource === "sceneDepth" ? geometry.geometryWorldNormalTexture : geometry.geometryNormViewDepthTexture,
              logicalBuffers: { sceneDepth: geometry.geometryNormViewDepthTexture, sceneNormal: geometry.geometryWorldNormalTexture },
              stack: [0, 1].map((order) => ({ id: `entry-${order}`, materialGuid: "logical", order, enabled: true })),
              documentFor: () => buffer === "post-normal" ? createDefaultMaterialDocument("Initial Scene Color", "postProcess") : post,
              onDiagnostic: (diagnostic) => { graphDiagnostics.push(diagnostic); },
            });
            if (buffer === "post-normal") {
              // Geometry normal initially has no consumer. Default allocation
              // aliasing must not overwrite it when a hot replacement starts
              // sampling it without changing this caller-owned handle set.
              replaceAfterBuild = async () => {
                for (const task of stack.tasks) await task.replaceDocument(post);
              };
            }
            copy.sourceTexture = stack.outputTexture;
          }
          graph.addTask(copy);
          await graph.buildAsync(false);
          await replaceAfterBuild?.();
          if (graphDiagnostics.length) throw new Error(JSON.stringify(graphDiagnostics));
          const deadline = performance.now() + 10_000;
          while (!graph.isReady()) {
            if (performance.now() > deadline) throw new Error("Geometry readiness timed out");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
          }
          engine.beginFrame();
          try { graph.execute(); } finally { engine.endFrame(); }
          if (graphDiagnostics.length) throw new Error(JSON.stringify(graphDiagnostics));
          const pixels = await engine.readPixels(16, 16, 1, 1);
          const pixel = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, 4));
          if (backend === "webgpu" && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
            [pixel[0], pixel[2]] = [pixel[2]!, pixel[0]!];
          captures.push({ material: mode, buffer, pixel });
        } finally {
          // FrameGraph.dispose resets tasks but does not dispose their owned services.
          for (const task of graph.tasks) task.dispose();
          graph.dispose();
        }
      }
    }
    return { backend, captures, retainedGraphs: scene.frameGraphs.length,
      retainedRenderers: scene.objectRenderers.length, legacyPrepass: !!scene.prePassRenderer };
  } finally {
    library.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
