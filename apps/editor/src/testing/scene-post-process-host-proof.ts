import { Color3, Color4, MeshBuilder, StandardMaterial, type Scene } from "@babylonjs/core";
import { createAppEngine, createAppWebGpuEngine, createEngine } from "@babylonslate/render";
import { managedLightingReservations } from "@babylonslate/render/managed-lighting-resources";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

function multiplyDocument(kind: "gain" | "mask") {
  const doc = createDefaultMaterialDocument(kind, "postProcess");
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  const connect = (source: string, pin: string, target: string, input: string) => doc.edges.push({
    id: `${source}-${pin}-${target}-${input}`, sourceNodeId: source, sourcePinId: pin,
    targetNodeId: target, targetPinId: input,
  });
  doc.nodes.push({ id: "multiply", type: "math.multiply", properties: {}, position: { x: 0, y: 0 } });
  connect("sceneColor", "color", "multiply", "a");
  connect("multiply", "out", "output", "color");
  if (kind === "gain") {
    doc.nodes.push({ id: "gain", type: "param.float", properties: { name: "Gain", value: [0.5] }, position: { x: 0, y: 0 } });
    doc.nodes.push({ id: "gainRgb", type: "vector.combine", properties: { w: 1 }, position: { x: 0, y: 0 } });
    for (const channel of ["x", "y", "z"]) connect("gain", "out", "gainRgb", channel);
    // Preserve coverage: the visible canvas returns unpremultiplied pixels.
    connect("gainRgb", "xyzw", "multiply", "b");
  } else {
    doc.nodes.push({ id: "mask", type: "texture.sample", properties: { textureGuid: "mask" }, position: { x: 0, y: 0 } });
    connect("screenUv", "uv", "mask", "uv");
    connect("mask", "rgba", "multiply", "b");
  }
  return doc;
}

/** Real registered Play view and layer hosts; only one texture's transport is held by the browser. */
export async function createScenePostProcessHostProof(backend: "webgl2" | "webgpu") {
  const root = document.getElementById("root")!;
  const canvas = document.createElement("canvas");
  canvas.width = 80; canvas.height = 64;
  canvas.style.width = "80px"; canvas.style.height = "64px";
  root.append(canvas);
  const privateCanvas = document.createElement("canvas");
  privateCanvas.width = 80; privateCanvas.height = 64;
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(privateCanvas) : createAppEngine(privateCanvas);
  const numeric = document.createElement("canvas"); numeric.width = numeric.height = 1;
  numeric.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray([0, 255, 0, 255]), 1, 1), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => numeric.toBlob((value) => value ? resolve(value) : reject(new Error("Numeric mask encoding failed")), "image/png"));
  const maskBytes = new Uint8Array(await blob.arrayBuffer());
  const diagnostics: unknown[] = [];
  const documents = new Map([
    ["gain", multiplyDocument("gain")], ["mask", multiplyDocument("mask")],
    ["identity", createDefaultMaterialDocument("Identity", "postProcess")],
  ]);
  const handle = createEngine(canvas, {
    sharedEngine: engine, playMode: true, frameCap: 30,
    environmentColor: [160 / 255, 80 / 255, 40 / 255],
    materialDocuments: documents, textureBytes: new Map([["mask", maskBytes]]),
    postProcessStack: [{ id: "world", materialGuid: "gain", enabled: true }],
    onPostProcessDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  let frames = 0;
  const paths = { world: false, layer: false };
  const worldObserver = handle.scene.onBeforeRenderObservable.add(() => {
    frames++; paths.world ||= handle.scene.frameGraph != null;
  });
  const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 15_000;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error("Host proof did not reach its owned frame boundary");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };
  const owner = { layerId: "overlay", layerLoadId: 1 };
  const addLayer = (id: string, zOrder: number, processed: boolean) => {
    handle.applyCommand({ type: "sceneLayerLoading", layerId: id, assetGuid: id, layerLoadId: 1 });
    handle.applyCommand({ type: "sceneLayerCreate", layerId: id, assetGuid: id, zOrder,
      ownerSceneGuid: null, layerBounds: { width: 4, height: 4 },
      postProcessStack: processed ? [{ id: "layer", materialGuid: "identity", enabled: true }] : [],
    });
    return handle.sceneLayerScenes().find((layer) => layer.layerId === id)!.scene;
  };
  const plane = (scene: Scene, name: string, x: number, y: number, width: number, height: number, color: Color3) => {
    const mesh = MeshBuilder.CreatePlane(name, { width, height }, scene);
    mesh.position.set(x, y, 0);
    const material = new StandardMaterial(name, scene);
    material.disableLighting = true; material.emissiveColor = color; material.backFaceCulling = false;
    mesh.material = material;
    return material;
  };
  let layer: Scene;
  let sibling: StandardMaterial;
  let replacement: Promise<void> | undefined;
  let presented = false;
  let error: string | null = null;
  let interceptedTextures = 0;
  let interceptNext = false;
  const createTexture = engine.createTexture.bind(engine);
  // Preserve the real native loader, shader and upload. A single known source
  // uses a same-origin HTTP transport so Playwright can delay actual bytes.
  engine.createTexture = (url, ...args) => {
    if (interceptNext && typeof url === "string" && url.startsWith("blob:")) {
      interceptNext = false; interceptedTextures++;
      // The cache supplies bytes as well as a URL. Clear only this transport's
      // buffer so the real loader waits for the browser-controlled HTTP source.
      args[6] = null;
      return createTexture("/__host-numeric-mask.png", ...args);
    }
    return createTexture(url, ...args);
  };
  const sample = async () => {
    const after = frames + 3;
    await wait(() => frames >= after);
    const context = canvas.getContext("2d")!;
    const pixel = (x: number, y: number) => Array.from(context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data);
    return { overlay: pixel(0.25, 0.5), world: pixel(0.75, 0.75), sibling: pixel(0.75, 0.25), frames,
      presented, error, paths: { ...paths }, interceptedTextures, diagnostics: [...diagnostics] };
  };
  let cleanup: Promise<{ scenes: number; reservedBytes: number; engineDisposed: boolean; diagnostics: unknown[] }> | undefined;
  const dispose = () => cleanup ??= (async () => {
    engine.createTexture = createTexture;
    handle.scene.onBeforeRenderObservable.remove(worldObserver);
    handle.dispose();
    await wait(() => handle.scene.isDisposed);
    await Promise.resolve();
    // The app's next native boundary drains deferred frees, without a Scene draw.
    engine.beginFrame(); engine.endFrame();
    const result = { scenes: engine.scenes.length, reservedBytes: managedLightingReservations(engine).reservedBytes,
      engineDisposed: engine.isDisposed, diagnostics };
    engine.dispose(); canvas.remove(); privateCanvas.remove();
    return result;
  })();
  try {
    await handle.prewarmSceneMaterials(); await handle.presentFirstFrame();
    layer = addLayer("overlay", 0, true);
    layer.onBeforeRenderObservable.add(() => { paths.layer ||= layer.frameGraph != null; });
    plane(layer, "Left Receiver", -1, 0, 2, 4, new Color3(0.8, 0.2, 0.1));
    const siblingScene = addLayer("sibling", 1, false);
    sibling = plane(siblingScene, "Right Receiver", 1, 1, 1, 1, new Color3(0.1, 0.8, 0.1));
    for (const id of ["overlay", "sibling"]) {
      const identity = { layerId: id, layerLoadId: 1 };
      await handle.prewarmSceneMaterials(identity); await handle.presentFirstFrame(identity);
    }
    return {
      maskBytes: [...maskBytes], sample, dispose,
      beginReplacement() {
        interceptNext = true;
        handle.applyCommand({ type: "sceneLayerPostProcess", layerId: "overlay",
          postProcessStack: [{ id: "layer", materialGuid: "mask", enabled: true }],
        });
        const ready = handle.prewarmSceneMaterials(owner);
        const first = handle.presentFirstFrame(owner).then(() => { presented = true; });
        replacement = Promise.all([ready, first]).then(() => {}, (reason: unknown) => { error = String(reason); });
        handle.scene.clearColor = new Color4(40 / 255, 80 / 255, 160 / 255, 1);
        sibling.emissiveColor = new Color3(0.8, 0.8, 0.1);
      },
      async finishReplacement() {
        await replacement;
        if (error) throw new Error(error);
        return sample();
      },
      async resize() {
        canvas.style.width = "96px"; handle.resize();
        await handle.prewarmSceneMaterials();
        await handle.prewarmSceneMaterials(owner); await handle.presentFirstFrame(owner);
        return sample();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
