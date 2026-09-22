/** Numeric native ownership and pixel fixtures; reachable only in test builds. */
import { Color3, Color4, Engine, FreeCamera, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { installAssetBytes } from "@babylonslate/assets";
import { parseText2DProperties } from "@babylonslate/core";
import {
  applyAssignMesh, beginSlotModelAnimLoad, bindResourceCacheToHandle,
  createAppWebGpuEngine, createModelActorRoot, createSnapshotSceneBinding, createText2DMesh,
  encodePngRgba, encodeTriangleGlb, installTextureBytes, ResourceCache,
} from "@babylonslate/render";

export async function runVisualGenerationProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  const cache = new ResourceCache();
  const owner = bindResourceCacheToHandle(cache);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -3), scene);
  camera.setTarget(Vector3.Zero());
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = camera.orthoBottom = -1.5;
  camera.orthoRight = camera.orthoTop = 1.5;
  scene.activeCamera = camera;
  scene.clearColor = new Color4(0, 0, 0, 1);
  const material = new StandardMaterial("borrowed", scene);
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.diffuseColor = Color3.Black();
  material.emissiveColor = Color3.Red();
  const binding = createSnapshotSceneBinding();
  const root = createModelActorRoot(scene, "model");
  root.position.set(-0.5, -0.5, 0);
  const modelBuffer = await installAssetBytes(encodeTriangleGlb()).arrayBuffer();
  const replace = () => beginSlotModelAnimLoad(scene, binding, 0, "model", new Blob([modelBuffer]), root,
    undefined, undefined, (prepared) => {
      for (const mesh of prepared.getChildMeshes()) if (mesh.getTotalVertices()) mesh.material = material;
    });
  const fontSources = installTextureBytes(new Map([["font", encodePngRgba(1, 1, new Uint8Array([255, 255, 255, 255]))]]))!;
  const fontJson = new TextEncoder().encode(JSON.stringify({ info: { size: 1 }, common: { scaleW: 1, scaleH: 1 }, chars: [
    { id: 65, x: 0, y: 0, width: 1, height: 1, xoffset: 0, yoffset: 0, xadvance: 1 },
  ] }));
  const assets = { resourceCache: owner.cache, fontMsdfJson: new Map([["font", fontJson]]), fontMsdfPng: fontSources };
  const pixels = async () => {
    await scene.whenReadyAsync();
    engine.beginFrame(); scene.render(); engine.endFrame();
    const readback = await engine.readPixels(0, 0, 128, 128);
    const data = new Uint8Array(readback.buffer, readback.byteOffset, readback.byteLength);
    const bgra = engine.isWebGPU && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm";
    let red = 0, white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + (bgra ? 2 : 0)]! > 180 && data[i + 1]! < 40 && data[i + (bgra ? 0 : 2)]! < 40) red++;
      if (data[i]! > 180 && data[i + 1]! > 180 && data[i + 2]! > 180) white++;
    }
    return { red, white };
  };
  const counts = () => ({
    materials: scene.materials.length, multiMaterials: scene.multiMaterials.length,
    meshes: scene.meshes.length, transforms: scene.transformNodes.length,
    geometries: scene.geometries.length, textures: engine.getLoadedTexturesCache().length,
    effectsObservers: scene.onBeforeRenderObservable.observers.length,
    disposalObservers: scene.onDisposeObservable.observers.length,
    leases: cache.resourceStats().leases,
  });
  const cycleText = async () => {
    const text = createText2DMesh(scene, "rich", { text: "[wave=2][u]A[/u]Ω", size: 32, fontAssetGuid: "font", renderer: "msdf" }, assets, { rich: true });
    text.position.y = 0.75;
    const drawn = await pixels();
    text.dispose();
    return drawn;
  };
  try {
    await replace();
    const richPixels = await cycleText();
    await pixels(); await new Promise((resolve) => setTimeout(resolve, 0));
    const warmed = counts();
    const durations: number[] = [];
    for (let cycle = 0; cycle < 100; cycle++) {
      const started = performance.now();
      await replace(); await cycleText();
      durations.push(performance.now() - started);
    }
    await pixels(); await new Promise((resolve) => setTimeout(resolve, 0));
    const retired = counts();
    const modelPixels = await pixels();
    const textBinding = createSnapshotSceneBinding();
    textBinding.liveSlots.add(2);
    applyAssignMesh(scene, textBinding, { type: "assignMesh", slotId: 2, meshKind: "2dtext", meshAssetGuid: null, text2d: parseText2DProperties({ text: "A", size: 64 }) });
    const text = textBinding.meshes.get(2)!;
    text.position.set(0, 0.7, 0);
    const beforeFailure = await pixels();
    applyAssignMesh(scene, textBinding, { type: "assignMesh", slotId: 2, meshKind: "2dtext", meshAssetGuid: null, text2d: parseText2DProperties({ text: "A", size: Number.MAX_SAFE_INTEGER }) });
    const afterFailure = await pixels();
    const preservedText = textBinding.meshes.get(2) === text && !text.isDisposed();
    root.dispose();
    const afterModelDisposal = await pixels();
    const borrowedMaterialAlive = scene.materials.includes(material);
    text.dispose();
    durations.sort((a, b) => a - b);
    return {
      backend: engine.isWebGPU ? "webgpu" : engine.webGLVersion === 2 ? "webgl2" : "webgl1",
      warmed, retired, richPixels, modelPixels, beforeFailure, afterFailure, preservedText,
      afterModelDisposal, borrowedMaterialAlive,
      preparationMs: { p50: durations[49], p95: durations[94], p99: durations[98] },
    };
  } finally {
    scene.dispose(); owner.releaseHandleRetains(); cache.dispose(); engine.dispose(); canvas.remove();
  }
}
