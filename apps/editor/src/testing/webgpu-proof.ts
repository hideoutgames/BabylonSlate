/** Test-build-only WebGPU capability and native shader proof. */
import {
  Color3,
  Color4,
  Engine,
  EngineStore,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  compileMaterialPlan,
  setSceneRenderSettings,
} from "@babylonslate/render";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

export async function runWebGpuProof() {
  const initialEngines = EngineStore.Instances.length;
  const captures = [];
  for (const backend of ["webgl2", "webgpu"] as const) {
    if (backend === "webgpu" && !(await WebGPUEngine.IsSupportedAsync))
      throw new Error("The local browser did not provide a WebGPU adapter.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    document.getElementById("root")!.append(canvas);
    const engine =
      backend === "webgpu"
        ? new WebGPUEngine(canvas, {
            antialias: false,
            adaptToDeviceRatio: false,
            enableAllFeatures: false,
          })
        : new Engine(canvas, false, {
            preserveDrawingBuffer: true,
            stencil: true,
          });
    try {
      if (engine instanceof WebGPUEngine) await engine.initAsync();
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
      }
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }
  return {
    captures,
    retainedEngines: EngineStore.Instances.length - initialEngines,
  };
}
