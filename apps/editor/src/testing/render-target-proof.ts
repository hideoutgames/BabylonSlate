import { Color3, Color4, Engine, FreeCamera, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createDefaultRenderTargetCaptureProperties, type RenderTargetMode } from "@babylonslate/core";
import { createAppWebGpuEngine, RenderTargetCaptures } from "@babylonslate/render";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";

/** Real capture shaders and texture sampling, with numeric primitive fixtures. */
export async function runRenderTargetProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  const captures = new RenderTargetCaptures(scene);
  try {
    engine.setSize(32, 32);
    scene.clearColor = new Color4(0, 0, 0, 0);
    const main = new FreeCamera("Main View", new Vector3(5, 0, -5), scene);
    main.setTarget(Vector3.Zero()); scene.activeCamera = main;
    const root = new Mesh("Capture Actor", scene); root.position.z = -4;
    const plane = MeshBuilder.CreatePlane("Numeric Plane", { size: 4 }, scene);
    const material = new StandardMaterial("Numeric Red", scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.Red(); material.diffuseColor = Color3.Black();
    plane.material = material;
    captures.registerActor("plane", () => plane);
    const settings = { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target", captureEveryFrame: false, nearClip: 1, farClip: 11 };
    captures.configure("capture", settings, () => root);
    const textures = new Map([["texture", { renderTargetGuid: "target" }]]);
    const results: Array<{ mode: string; pixel: number[] }> = [];
    const capture = async (mode: RenderTargetMode, onlyActors = false) => {
      captures.setAssets(new Map([["target", { mode, width: 32, height: 32 }]]), textures);
      captures.configure("capture", { ...settings, captureOnlyActors: onlyActors, actorIds: [] }, () => root);
      const texture = captures.acquireTexture("texture")!.resource;
      captures.request("capture");
      const deadline = performance.now() + 10000;
      do {
        engine.beginFrame(); captures.render(); engine.endFrame();
        if (scene.activeCamera !== main) throw new Error("Capture replaced the main camera.");
        if (texture.getSize().width === 32) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() < deadline);
      if (texture.getSize().width !== 32) throw new Error(`Capture shader did not become ready: ${mode}`);
      const pixels = await texture.readPixels(0, 0, null, true, false, 16, 16, 1, 1);
      if (!pixels) throw new Error("Capture returned no pixels.");
      const values = Array.from(pixels as Uint8Array | Float32Array);
      results.push({ mode: onlyActors ? "Empty Filter" : mode, pixel: values });
    };
    for (const mode of ["SceneColor", "DepthPass", "WorldNormal"] as const) await capture(mode);
    await capture("WorldNormal", true);
    captures.clear();
    return { results, retainedBytes: managedRenderReservations(engine).reservedBytes, mainCameraPreserved: scene.activeCamera === main };
  } finally { captures.dispose(); scene.dispose(); engine.dispose(); canvas.remove(); }
}
