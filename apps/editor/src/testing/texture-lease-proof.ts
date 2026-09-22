/** Test-build-only real buffer/material and solid-color pixel ownership fixture. */
import { Color3, Color4, Engine, FreeCamera, Scene, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
import { createDefaultSpriteAnimationPayload, createDefaultSpritePayload } from "@babylonslate/assets";
import {
  applyAlbedoTexture, applyAnimStateToScene, applySpriteAnimationAssetFrame, applySpriteFrameUvs,
  bindResourceCacheToHandle, createAppWebGpuEngine, createSpriteQuad,
  encodePngRgba, installTextureBytes, PIXEL_ART_TEXTURE_SAMPLING, ResourceCache,
} from "@babylonslate/render";

export async function runTextureLeaseProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const cache = new ResourceCache();
  const owner = bindResourceCacheToHandle(cache);
  const siblingOwner = bindResourceCacheToHandle(cache);
  const scene = new Scene(engine);
  const layer = new Scene(engine);
  const frame = { name: "solid", u: 0, v: 0, uSize: 1, vSize: 1, durationMs: 100, pivot: { x: 0.5, y: 0.5 }, width: 100, height: 100 };
  const sources = installTextureBytes(new Map([
    ["solid", encodePngRgba(1, 1, new Uint8Array([255, 0, 0, 255]))],
    ["atlas", encodePngRgba(2, 1, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]))],
  ]))!;
  const assets = { resourceCache: owner.cache, textureBytes: sources };
  const mesh = createSpriteQuad(scene, "primary", frame);
  const sibling = createSpriteQuad(layer, "layer", frame);
  const animation = createDefaultSpriteAnimationPayload();
  animation.frames[0] = { ...animation.frames[0]!, textureGuid: "solid", width: 100, height: 100 };
  const apply = () => applySpriteAnimationAssetFrame(mesh, animation, 0, { applyTexture: (target, guid) => applyAlbedoTexture(target, target.getScene(), guid, assets) });
  const operations = { acquisitions: 0, materials: 0, buffers: 0, updates: 0 };
  const originalAcquire = owner.cache.acquireTexture.bind(owner.cache);
  owner.cache.acquireTexture = (...args) => { operations.acquisitions++; return originalAcquire(...args); };
  const originalCreate = engine.createVertexBuffer.bind(engine);
  engine.createVertexBuffer = (...args) => { operations.buffers++; return originalCreate(...args); };
  const originalDynamic = engine.createDynamicVertexBuffer.bind(engine);
  engine.createDynamicVertexBuffer = (...args) => { operations.buffers++; return originalDynamic(...args); };
  const originalUpdate = engine.updateDynamicVertexBuffer.bind(engine);
  engine.updateDynamicVertexBuffer = (...args) => { operations.updates++; return originalUpdate(...args); };
  scene.onNewMaterialAddedObservable.add(() => operations.materials++);
  const reset = () => Object.assign(operations, { acquisitions: 0, materials: 0, buffers: 0, updates: 0 });
  const pixels = async () => {
    engine.beginFrame(); scene.render(); engine.endFrame();
    const bytes = await engine.readPixels(32, 32, 1, 1);
    const pixel = Array.from(new Uint8Array(bytes.buffer, bytes.byteOffset, 4));
    if (backend === "webgpu" && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
      [pixel[0], pixel[2]] = [pixel[2]!, pixel[0]!];
    return pixel;
  };
  try {
    const camera = new FreeCamera("camera", new Vector3(0, 0, -2), scene);
    camera.setTarget(Vector3.Zero()); scene.activeCamera = camera;
    scene.clearColor = new Color4(0, 0, 0, 1);
    apply();
    applyAlbedoTexture(sibling, scene, "solid", { resourceCache: siblingOwner.cache, textureBytes: sources });
    const atlas = cache.acquireTexture("atlas", engine, sources.get("atlas")!, { ...PIXEL_ART_TEXTURE_SAMPLING, hasAlpha: true });
    await atlas.ready; atlas.release();
    await scene.whenReadyAsync();
    apply(); await pixels();
    const material = mesh.material;
    const uvBuffer = mesh.getVertexBuffer(VertexBuffer.UVKind);
    const positionBuffer = mesh.getVertexBuffer(VertexBuffer.PositionKind);
    reset();
    const before = performance.now();
    const batches: number[] = [];
    for (let batch = 0; batch < 100; batch++) {
      const started = performance.now();
      for (let i = 0; i < 100; i++) apply();
      batches.push(performance.now() - started);
    }
    batches.sort((a, b) => a - b);
    const stableBatchMs = { p50: batches[49], p95: batches[94], p99: batches[98] };
    const stableMs = performance.now() - before;
    const stable = { ...operations };
    const stableResources = mesh.material === material && mesh.getVertexBuffer(VertexBuffer.UVKind) === uvBuffer && mesh.getVertexBuffer(VertexBuffer.PositionKind) === positionBuffer;
    reset();
    animation.frames[0]!.width = 150;
    animation.frames[0]!.pivot.x = 0.25;
    apply();
    const dimensions = { ...operations };
    animation.frames[0]!.width = 100;
    animation.frames[0]!.pivot.x = 0.5;
    apply();
    reset();
    applyAlbedoTexture(mesh, layer, "atlas", assets);
    applySpriteFrameUvs(mesh, { ...frame, uSize: 0.5 });
    const red = await pixels();
    applySpriteFrameUvs(mesh, { ...frame, u: 0.5, uSize: 0.5 });
    const green = await pixels();
    const atlasChange = { ...operations };
    const overlay = createSpriteQuad(scene, "crossfade", frame);
    const otherAnimation = createDefaultSpriteAnimationPayload();
    otherAnimation.frames[0] = { ...otherAnimation.frames[0]!, textureGuid: "atlas", width: 100, height: 100 };
    const slot = { mesh, overlayMesh: overlay, payload: createDefaultSpritePayload(),
      spriteAnimations: new Map([["primary", animation], ["secondary", otherAnimation]]),
      applyTexture: (target: typeof mesh, guid: string | null | undefined) => applyAlbedoTexture(target, target.getScene(), guid, assets) };
    const fade = (weight: number) => applyAnimStateToScene({ animationGroups: [], getSpriteSlot: () => slot }, {
      type: "animState", slotId: 0, stateId: "primary", normalisedTime: 0, blendWeights: {}, layers: [
        { stateId: "primary", clipAssetGuid: "primary", clipName: "", clipKind: "sprite", normalisedTime: 0, weight },
        { stateId: "secondary", clipAssetGuid: "secondary", clipName: "", clipKind: "sprite", normalisedTime: 0, weight: 1 - weight },
      ],
    });
    fade(0.4);
    reset(); fade(0.2);
    const crossfade = { ...operations };
    const crossfadeWeights = [mesh.visibility, overlay.visibility];
    const independentAtlases = (mesh.material as StandardMaterial).diffuseTexture !== (overlay.material as StandardMaterial).diffuseTexture;
    const authored = new StandardMaterial("authored", scene);
    authored.disableLighting = true; authored.emissiveColor = Color3.Blue();
    mesh.material = authored;
    apply();
    const preservesAuthored = mesh.material === authored;
    const layerMaterialScene = sibling.material?.getScene() === layer;
    scene.dispose(); owner.dispose(); cache.flushUnreferenced();
    const siblingTexture = (sibling.material as StandardMaterial).diffuseTexture;
    const siblingSurvives = siblingTexture?.isReady() === true;
    layer.dispose(); siblingOwner.dispose(); cache.flushUnreferenced();
    return { requestedBackend: backend, backend: engine.isWebGPU ? "webgpu" : "webgl2", driver: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(), stable, stableMs, stableBatchMs, stableResources, dimensions, atlasChange, crossfade, crossfadeWeights, independentAtlases, red, green, preservesAuthored, layerMaterialScene, siblingSurvives, retired: cache.resourceStats() };
  } finally {
    scene.dispose(); layer.dispose(); owner.dispose(); siblingOwner.dispose(); cache.dispose(); engine.dispose(); canvas.remove();
  }
}
