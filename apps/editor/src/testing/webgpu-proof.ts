/** Test-build-only WebGPU capability and native shader proof. */
import {
  Color3,
  Color4,
  DirectionalLight,
  Camera,
  EngineStore,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
  type AbstractEngine,
} from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  applyAuthoredLightProperties,
  compileMaterialPlan,
  createAppEngine,
  createAppWebGpuEngine,
  createEditorGrid,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
  createText2DMesh,
  ResourceCache,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { normalizeShadowSettings } from "@babylonslate/core";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

export async function runWebGpuProof() {
  const initialEngines = EngineStore.Instances.length;
  const captures = [];
  const previews = [];
  const helpers = [];
  const shadows = [];
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
      for (const kind of ["grid", "bounds", "msdf"] as const) {
        helpers.push({
          backend,
          kind,
          pixelFormat: swapChainFormat ?? "rgba8unorm",
          pixelOrigin: backend === "webgpu" ? "top-left" : "bottom-left",
          ...await captureHelper(engine, kind),
        });
      }
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
      engine.setSize(96, 72);
      for (const mode of ["pbr", "cel"] as const)
        shadows.push({ backend, mode, ...await captureSunShadows(engine, mode) });
    } finally {
      engine.dispose();
      canvas.remove();
    }
  }
  return {
    captures,
    previews,
    helpers,
    shadows,
    cancelledEngineReleased,
    retainedEngines: EngineStore.Instances.length - initialEngines,
  };
}

async function captureSunShadows(engine: AbstractEngine, mode: "pbr" | "cel") {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.04, 0.07, 0.12, 1);
  const camera = new FreeCamera("shadow camera", new Vector3(0, 4, -7), scene);
  camera.setTarget(new Vector3(0, 0.3, 0));
  camera.minZ = 0.1;
  camera.maxZ = 30;
  new HemisphericLight("fill", Vector3.Up(), scene).intensity = 0.12;
  const light = new DirectionalLight("sun", new Vector3(2, -4, 2).normalize(), scene);
  const setShadows = (enabled: boolean) => applyAuthoredLightProperties(light, {
    intensity: 2, castShadows: enabled,
  });
  setShadows(true);
  const native = new PBRMaterial("native receiver", scene);
  native.albedoColor = new Color3(0.05, 0.55, 0.12);
  native.metallic = 0;
  native.roughness = 1;
  setSceneRenderSettings(scene, { mode, shadows: normalizeShadowSettings({
    cascades: 2, mapSize: 256, autoBias: false, normalBias: 0.02,
    depthBias: 0.0001, distance: 25,
  }) });
  const document = createDefaultMaterialDocument("graph receiver");
  document.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.05, 0.55, 0.12];
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error("Shadow surface did not lower");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph receiver" });
  if (!compiled.ok || (await compiled.ready).some((entry) => entry.severity === "error"))
    throw new Error("Shadow surface did not compile");
  try {
    for (const [index, material] of [native, compiled.material].entries()) {
      const x = index === 0 ? -1.5 : 1.5;
      const floor = MeshBuilder.CreateGround(`receiver-${index}`, { width: 3, height: 6 }, scene);
      floor.position.x = x;
      floor.material = material;
      const caster = MeshBuilder.CreateBox(`caster-${index}`, { width: 0.7, depth: 0.7, height: 1.4 }, scene);
      caster.position.set(x, 0.7, 0);
      caster.material = material;
    }
    setSceneRenderSettings(scene);
    const read = async () => {
      await scene.whenReadyAsync(true);
      for (let frame = 0; frame < 3; frame++) {
        engine.beginFrame();
        scene.render(false);
        engine.endFrame();
      }
      const pixels = await engine.readPixels(0, 0, 96, 72);
      return Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    };
    const shadowed = await read();
    setShadows(false);
    setSceneRenderSettings(scene);
    const unshadowed = await read();
    return { shadowed, unshadowed };
  } finally {
    compiled.dispose();
    scene.dispose();
  }
}

async function captureHelper(engine: AbstractEngine, kind: "grid" | "bounds" | "msdf") {
  const scene = new Scene(engine);
  const cache = new ResourceCache();
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("helper camera", new Vector3(0, 0, -4), scene);
  camera.setTarget(Vector3.Zero());
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = camera.orthoBottom = -2;
  camera.orthoRight = camera.orthoTop = 2;
  let disposeGrid: (() => void) | undefined;
  try {
    if (kind === "msdf") {
      // Numeric distance values exercise the actual glyph shader without an art fixture.
      const atlas = document.createElement("canvas");
      atlas.width = atlas.height = 16;
      const context = atlas.getContext("2d")!;
      const data = context.createImageData(16, 16);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        data.data[i] = data.data[i + 1] = data.data[i + 2] = x * 17;
        data.data[i + 3] = 255;
      }
      context.putImageData(data, 0, 0);
      const png = await new Promise<Blob>((resolve, reject) => atlas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Numeric atlas encoding failed"))));
      const text = createText2DMesh(scene, "numeric MSDF", {
        text: "A", renderer: "msdf", size: 16, fontAssetGuid: "numeric", color: [0.2, 0.8, 0.4],
      }, {
        pixelsPerUnit: 8,
        resourceCache: cache,
        fontMsdfPng: new Map([["numeric", new Uint8Array(await png.arrayBuffer())]]),
        fontMsdfJson: new Map([["numeric", new TextEncoder().encode(JSON.stringify({
          info: { size: 16 }, common: { scaleW: 16, scaleH: 16 },
          chars: [{ id: 65, x: 0, y: 0, width: 16, height: 16, xoffset: 0, yoffset: 0, xadvance: 16 }],
        }))]]),
      });
      const glyph = text.getChildMeshes()[0]!;
      glyph.position.setAll(0);
      if (!(glyph.material instanceof ShaderMaterial)) throw new Error("MSDF shader fell back");
    } else {
      const grid = createEditorGrid(scene, {
        mode: "2d", camera: { target: Vector3.Zero(), radius: 4, orthoTop: 2, orthoRight: 2 },
      });
      disposeGrid = grid.dispose;
      grid.setVisible(kind === "grid");
      grid.setCameraBounds(kind === "bounds" ? { width: 2.75, height: 2.75 } : null);
      grid.sync();
    }
    await scene.whenReadyAsync();
    for (const mesh of scene.meshes) await mesh.material?.forceCompilationAsync(mesh);
    for (let frame = 0; frame < 3; frame++) {
      engine.beginFrame();
      scene.render(false);
      engine.endFrame();
    }
    const pixels = await engine.readPixels(0, 0, 64, 64);
    return {
      pixels: [...new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)],
      shaderLanguages: scene.materials.filter((material) => material instanceof ShaderMaterial).map((material) => material.options.shaderLanguage),
    };
  } finally {
    disposeGrid?.();
    scene.dispose();
    cache.dispose();
  }
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
