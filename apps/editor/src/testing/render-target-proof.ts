import { Color3, Color4, Engine, FreeCamera, Material, Mesh, MeshBuilder, RawTexture, RenderTargetTexture, Scene, StandardMaterial, Texture, Vector3, VertexBuffer } from "@babylonjs/core";
import { createDefaultRenderTargetCaptureProperties, type RenderTargetMode } from "@babylonslate/core";
import { createAppWebGpuEngine, disposeMeshLatticeDeformer, MaterialLibrary, RenderTargetCaptures, setMeshLatticeDeformer } from "@babylonslate/render";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";

/** Real capture shaders and texture sampling, with numeric primitive fixtures. */
export async function runRenderTargetProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  const captures = new RenderTargetCaptures(scene);
  const materialScene = new Scene(engine);
  const library = new MaterialLibrary({ acquireTexture: (guid, consumerScene) => captures.acquireTexture(guid, consumerScene) });
  try {
    engine.setSize(32, 32);
    scene.clearColor = new Color4(0, 0, 0, 0);
    scene.imageProcessingConfiguration.applyByPostProcess = true;
    const main = new FreeCamera("Main View", new Vector3(5, 0, -5), scene);
    main.setTarget(Vector3.Zero()); scene.activeCamera = main;
    const root = new Mesh("Capture Actor", scene); root.position.z = -4;
    const plane = MeshBuilder.CreatePlane("Numeric Plane", { size: 4 }, scene);
    const material = new StandardMaterial("Numeric Midtone", scene);
    material.disableLighting = true;
    material.emissiveColor = new Color3(0.25, 0.5, 0.125); material.diffuseColor = Color3.Black();
    plane.material = material;
    // Compile/freeze the source under the main camera's linear-output setting
    // before a separate capture pass needs gamma-encoded surface output.
    await material.forceCompilationAsync(plane);
    material.freeze();
    captures.registerActor("plane", () => plane);
    const settings = { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target", captureEveryFrame: false, nearClip: 1, farClip: 11 };
    captures.configure("capture", settings, () => root);
    const textures = new Map([["texture", { renderTargetGuid: "target" }]]);
    captures.setAssets(new Map([["target", { mode: "SceneColor", width: 32, height: 32 }]]), textures);
    const screenCamera = new FreeCamera("Material View", new Vector3(0, 0, -4), materialScene);
    screenCamera.setTarget(Vector3.Zero()); materialScene.activeCamera = screenCamera;
    const screen = MeshBuilder.CreatePlane("Material Screen", { size: 4 }, materialScene);
    const graph = createDefaultMaterialDocument("Capture Sampler");
    graph.shadingModel = "unlit";
    graph.nodes.push({ id: "sample", type: "texture.sample", properties: { textureGuid: "texture" }, position: { x: 0, y: 0 } });
    graph.edges = [{ id: "capture-color", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" }];
    const acquired = library.acquire(materialScene, "sampler", graph);
    if (acquired.ok === false) throw new Error(JSON.stringify(acquired.diagnostics));
    const diagnostics = await acquired.ready;
    if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
    screen.material = acquired.material;
    acquired.material.allowShaderHotSwapping = false;
    await acquired.material.forceCompilationAsync(screen);
    acquired.material.freeze();
    const results: Array<{ mode: string; pixel: number[] }> = [];
    const sampleMaterial = async (mode: string) => {
      const deadline = performance.now() + 10000;
      do {
        engine.beginFrame(); materialScene.render(); engine.endFrame();
        if (acquired.material.isReadyForSubMesh(screen, screen.subMeshes![0]!)) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() < deadline);
      if (!acquired.material.isReadyForSubMesh(screen, screen.subMeshes![0]!)) throw new Error("Material sampler did not become ready.");
      const pixels = await engine.readPixels(16, 16, 1, 1);
      const pixel = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
      // Babylon returns the canvas attachment's native channel order on WebGPU.
      const canvasFormat = (engine.getCreationOptions() as { swapChainFormat?: string }).swapChainFormat;
      if (backend === "webgpu" && canvasFormat === "bgra8unorm")
        [pixel[0], pixel[2]] = [pixel[2]!, pixel[0]!];
      results.push({ mode, pixel });
    };
    const capture = async (mode: RenderTargetMode, onlyActors = false, label: string = mode) => {
      captures.setAssets(new Map([["target", { mode, width: 32, height: 32 }]]), textures);
      captures.configure("capture", { ...settings, captureOnlyActors: onlyActors, actorIds: [] }, () => root);
      const texture = captures.acquireTexture("texture")!.resource;
      captures.request("capture");
      const deadline = performance.now() + 10000;
      let captured = false;
      do {
        const target = scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture | undefined;
        const observer = target?.onAfterRenderObservable.add(() => { captured = true; });
        captures.request("capture");
        engine.beginFrame(); captures.render(); engine.endFrame();
        if (observer) target!.onAfterRenderObservable.remove(observer);
        if (scene.activeCamera !== main) throw new Error("Capture replaced the main camera.");
        if (!scene.imageProcessingConfiguration.applyByPostProcess) throw new Error("Capture changed the main image-processing configuration.");
        if (captured && texture.getSize().width === 32) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() < deadline);
      if (!captured || texture.getSize().width !== 32) throw new Error(`Capture shader did not become ready: ${mode}`);
      const pixels = await texture.readPixels(0, 0, null, true, false, 16, 16, 1, 1);
      if (!pixels) throw new Error("Capture returned no pixels.");
      const values = Array.from(pixels as Uint8Array | Float32Array);
      results.push({ mode: onlyActors ? "Empty Filter" : label, pixel: values });
    };
    await capture("SceneColor");
    await sampleMaterial("Material Color");
    for (const mode of ["DepthPass", "WorldNormal"] as const) {
      await capture(mode);
      await sampleMaterial(`Material ${mode}`);
    }
    const sourceGraph = createDefaultMaterialDocument("Authored Midtone");
    sourceGraph.shadingModel = "unlit";
    sourceGraph.nodes.push({ id: "color", type: "const.vec3", properties: { value: [0.125, 0.25, 0.5] }, position: { x: 0, y: 0 } });
    sourceGraph.edges = [{ id: "source-color", sourceNodeId: "color", sourcePinId: "out", targetNodeId: "output", targetPinId: "baseColor" }];
    const source = library.acquire(scene, "authored-source", sourceGraph);
    if (source.ok === false) throw new Error(JSON.stringify(source.diagnostics));
    const sourceDiagnostics = await source.ready;
    if (sourceDiagnostics.length) throw new Error(JSON.stringify(sourceDiagnostics));
    plane.material = source.material;
    await source.material.forceCompilationAsync(plane);
    source.material.freeze();
    await capture("SceneColor", false, "Authored SceneColor");
    await sampleMaterial("Material Color After Mode Change");
    await capture("WorldNormal", true);
    // Frozen authored material: geometry captures must retain the WPO/clip
    // subgraphs and observe live parameter edits without recreating the source.
    const displacedGraph = createDefaultMaterialDocument("Displaced Cutout");
    displacedGraph.shadingModel = "unlit"; displacedGraph.blendMode = "masked"; displacedGraph.alphaCutoff = 0.5;
    displacedGraph.nodes.push(
      { id: "x", type: "param.float", properties: { name: "Shift X", value: [0] }, position: { x: 0, y: 0 } },
      { id: "z", type: "param.float", properties: { name: "Shift Z", value: [2] }, position: { x: 0, y: 0 } },
      { id: "cutout", type: "param.float", properties: { name: "Cutout", value: [1] }, position: { x: 0, y: 0 } },
      { id: "offset", type: "vector.combine", properties: {}, position: { x: 0, y: 0 } },
    );
    displacedGraph.edges.push(
      { id: "x-offset", sourceNodeId: "x", sourcePinId: "out", targetNodeId: "offset", targetPinId: "x" },
      { id: "z-offset", sourceNodeId: "z", sourcePinId: "out", targetNodeId: "offset", targetPinId: "z" },
      { id: "offset-output", sourceNodeId: "offset", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "worldPositionOffset" },
      { id: "cutout-output", sourceNodeId: "cutout", sourcePinId: "out", targetNodeId: "output", targetPinId: "alphaClip" },
    );
    const displaced = library.acquire(scene, "displaced-source", displacedGraph);
    if (!displaced.ok) throw new Error(JSON.stringify(displaced.diagnostics));
    const displacedDiagnostics = await displaced.ready;
    if (displacedDiagnostics.length) throw new Error(JSON.stringify(displacedDiagnostics));
    plane.material = displaced.material;
    await displaced.material.forceCompilationAsync(plane);
    displaced.material.freeze();
    for (const mode of ["DepthPass", "WorldNormal"] as const) {
      await capture(mode, false, `Authored WPO ${mode}`);
      library.setParameter(scene, "displaced-source", "Shift X", { kind: "float", value: 5 });
      await capture(mode, false, `Authored Moved ${mode}`);
      library.resetParameter(scene, "displaced-source", "Shift X");
      library.setParameter(scene, "displaced-source", "Cutout", { kind: "float", value: 0 });
      await capture(mode, false, `Authored Discard ${mode}`);
      library.resetParameter(scene, "displaced-source", "Cutout");
      library.setParameter(scene, "displaced-source", "Shift Z", { kind: "float", value: 1 });
      await capture(mode, false, `Authored Edited ${mode}`);
      library.resetParameter(scene, "displaced-source", "Shift Z");
      await capture(mode, false, `Authored Reset ${mode}`);
    }
    // z' = 2z + 0.5x + 1: scaling the authored z-offset proves the cage runs
    // after WPO, while the tilted plane exposes inverse-transpose normals.
    const controls: number[] = [];
    for (const z of [-4, 4]) for (const y of [-4, 4]) for (const x of [-4, 4]) {
      void y; controls.push(0, 0, z + 0.5 * x + 1);
    }
    for (const [label, surface] of [["Native Lattice", material], ["Authored Lattice", displaced.material]] as const) {
      plane.material = surface;
      setMeshLatticeDeformer(plane, { enabled: true, resolution: [2, 2, 2], strength: 1, offsets: controls,
        fitToMesh: false, boundsMin: [-4, -4, -4], boundsMax: [4, 4, 4] });
      for (const mode of ["DepthPass", "WorldNormal"] as const) await capture(mode, false, `${label} ${mode}`);
      disposeMeshLatticeDeformer(plane);
    }
    // Opposing constant UV channels isolate mask selection from interpolation.
    plane.setVerticesData(VertexBuffer.UVKind, [0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5]);
    plane.setVerticesData(VertexBuffer.UV2Kind, [0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75, 0.5]);
    const mask = RawTexture.CreateRGBATexture(new Uint8Array(8), 2, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    mask.hasAlpha = true;
    const cutout = new StandardMaterial("Numeric Cutout", scene);
    cutout.transparencyMode = Material.MATERIAL_ALPHATEST;
    cutout.diffuseTexture = mask;
    plane.material = cutout;
    for (const [label, uv, left, right, cutoff] of [
      ["UV0 Opaque", 0, 255, 0, 0.5],
      ["UV0 Discard", 0, 0, 255, 0.5],
      ["UV1 Opaque", 1, 0, 255, 0.5],
      ["UV1 Discard", 1, 255, 0, 0.5],
      ["Cutoff Discard", 0, 115, 255, 0.5],
      ["Cutoff Opaque", 0, 115, 0, 0.4],
    ] as const) {
      mask.coordinatesIndex = uv;
      mask.update(new Uint8Array([255, 255, 255, left, 255, 255, 255, right]));
      cutout.alphaCutOff = cutoff;
      for (const mode of ["DepthPass", "WorldNormal"] as const) await capture(mode, false, `${label} ${mode}`);
    }
    // A monitor inside its own capture must sample the completed image while
    // the next one is drawn. Repeated swaps exercise frozen NodeMaterial
    // bindings on both GPU backends, including after the image changes.
    plane.material = material;
    await capture("SceneColor", false, "Feedback Seed");
    const feedback = library.acquire(scene, "feedback-sampler", graph);
    if (feedback.ok === false) throw new Error(JSON.stringify(feedback.diagnostics));
    const feedbackDiagnostics = await feedback.ready;
    if (feedbackDiagnostics.length) throw new Error(JSON.stringify(feedbackDiagnostics));
    feedback.material.allowShaderHotSwapping = false;
    plane.material = feedback.material;
    await feedback.material.forceCompilationAsync(plane);
    feedback.material.freeze();
    const feedbackOutput = captures.acquireTexture("texture")!.resource;
    const nextFeedback = async (label: string) => {
      const previous = feedbackOutput.getInternalTexture();
      captures.request("capture");
      const deadline = performance.now() + 10000;
      do {
        engine.beginFrame(); captures.render(); engine.endFrame();
        if (feedbackOutput.getInternalTexture() !== previous) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() < deadline);
      if (feedbackOutput.getInternalTexture() === previous) throw new Error(`Feedback capture did not complete: ${label}`);
      const pixels = await feedbackOutput.readPixels(0, 0, null, true, false, 16, 16, 1, 1);
      if (!pixels) throw new Error("Feedback capture returned no pixels.");
      results.push({ mode: label, pixel: Array.from(pixels as Uint8Array) });
    };
    await nextFeedback("Feedback First");
    await nextFeedback("Feedback Second");
    material.emissiveColor = Color3.Green();
    material.markDirty(true);
    plane.material = material;
    await nextFeedback("Feedback New Image");
    plane.material = feedback.material;
    await nextFeedback("Feedback Updated First");
    await nextFeedback("Feedback Updated Second");
    await sampleMaterial("Material After Feedback");
    captures.clear();
    captures.dispose();
    return { results, retainedBytes: managedRenderReservations(engine).reservedBytes, mainCameraPreserved: scene.activeCamera === main };
  } finally { library.dispose(); materialScene.dispose(); captures.dispose(); scene.dispose(); engine.dispose(); canvas.remove(); }
}
