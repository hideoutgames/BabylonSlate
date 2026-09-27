import {
  Constants, FreeCamera, HemisphericLight, LightConstants, Material, Mesh, MeshBuilder, MultiMaterial, NodeMaterial, NullEngine, ObjectRenderer, ParticleSystem, RawTexture, RenderTargetTexture,
  Scene, StandardMaterial, Vector3,
} from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import { createDefaultRenderTargetCaptureProperties } from "@babylonslate/core";
import { RenderTargetCaptures } from "./render-target-capture";
import { managedRenderReservations, limitManagedRenderBytes } from "./managed-render-resources";
import { GRID_MESH_NAME, CAMERA_BOUNDS_MESH_NAME } from "./editor-grid";
import * as normalMaterial from "./render-target-normal-material";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import { bindParticleMaterial } from "./particle-system-factory";
import { createSceneStreamAdmission, registerSceneStreamParticle } from "./scene-stream-admission";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
function host(floatingOrigin = false) {
  const engine = new NullEngine();
  if (floatingOrigin) vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  engines.push(engine);
  // NullEngine does not record the GPU allocator's format metadata.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  const scene = new Scene(engine, { useFloatingOrigin: floatingOrigin });
  const camera = new FreeCamera("Main Camera", new Vector3(0, 0, -5), scene);
  const captures = new RenderTargetCaptures(scene);
  captures.setAssets(new Map([["target", { mode: "SceneColor", width: 16, height: 8 }]]),
    new Map([["texture", { renderTargetGuid: "target" }]]));
  const root = new Mesh("Capture Root", scene);
  const settings = { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target", captureEveryFrame: false };
  captures.configure("capture", settings, () => root);
  // Drawing has a real-browser pixel proof; isolate that GPU boundary here.
  vi.spyOn(RenderTargetTexture.prototype, "isReadyForRendering").mockReturnValue(true);
  const draws: Array<readonly Mesh[]> = [];
  const particleDraws: unknown[][] = [];
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    draws.push([...(this.renderList ?? [])] as Mesh[]);
    particleDraws.push([...(this.particleSystemList ?? [])]);
  });
  return { engine, scene, camera, captures, root, settings, draws, particleDraws };
}

it("manual capture allocates only on demand, coalesces requests and preserves the last frame", () => {
  const { scene, camera, captures, draws, engine } = host();
  const output = captures.acquireTexture("texture")!.resource;
  captures.render();
  expect(draws).toHaveLength(0);
  expect(managedRenderReservations(engine).reservedBytes).toBe(4);
  captures.request("capture"); captures.request("capture"); captures.render();
  const published = output.getInternalTexture();
  expect(output.getSize()).toEqual({ width: 16, height: 8 });
  captures.render();
  expect(draws).toHaveLength(1);
  expect(output.getInternalTexture()).toBe(published);
  expect(output.isRenderTarget).toBe(false);
  expect(scene.customRenderTargets).toEqual([]);
  expect(scene.activeCamera).toBe(camera);
});

it("keeps color and data sampling distinct while sharing the uncaptured fallback", () => {
  const { captures } = host();
  const textures = new Map([["color", { renderTargetGuid: "colorTarget" }], ["data", { renderTargetGuid: "dataTarget" }]]);
  captures.setAssets(new Map([
    ["colorTarget", { mode: "SceneColor", width: 16, height: 8 }],
    ["dataTarget", { mode: "DepthPass", width: 16, height: 8 }],
  ]), textures);
  const color = captures.acquireTexture("color")!.resource;
  const data = captures.acquireTexture("data")!.resource;
  expect(color.getInternalTexture()).toBe(data.getInternalTexture());
  expect(color.gammaSpace).toBe(true);
  expect(data.gammaSpace).toBe(false);
  captures.setAssets(new Map([
    ["colorTarget", { mode: "WorldNormal", width: 16, height: 8 }],
    ["dataTarget", { mode: "SceneColor", width: 16, height: 8 }],
  ]), textures);
  expect(color.gammaSpace).toBe(false);
  expect(data.gammaSpace).toBe(true);
});

it("prepares clustered lighting once per requested color capture while retrying deferred readiness", () => {
  const { captures, scene } = host();
  vi.mocked(RenderTargetTexture.prototype.isReadyForRendering).mockRestore();
  vi.mocked(RenderTargetTexture.prototype.render).mockRestore();
  // Keep native readiness/init/draw lifecycle; replace only shader readiness
  // and the GPU clustered-light batch draw unavailable in NullEngine.
  vi.spyOn(ObjectRenderer.prototype, "_checkReadiness").mockReturnValueOnce(false).mockReturnValue(true);
  const light = new HemisphericLight("Cluster Boundary", Vector3.Up(), scene);
  vi.spyOn(light, "getTypeID").mockReturnValue(LightConstants.LIGHTTYPEID_CLUSTERED_CONTAINER);
  const batchDraw = vi.fn();
  const update = vi.fn<(camera: { name: string } | null) => { render: typeof batchDraw }>(() => ({ render: batchDraw }));
  Object.assign(light, { isSupported: true, _updateBatches: update });
  const output = captures.acquireTexture("texture")!.resource;
  captures.request("capture"); captures.render();
  expect(output.getSize().width).toBe(1);
  expect(batchDraw).toHaveBeenCalledTimes(1);
  captures.render();
  expect(output.getSize().width).toBe(16);
  expect(batchDraw).toHaveBeenCalledTimes(2);
  expect(update.mock.calls.every(([camera]) => camera?.name === "renderTargetCapture:capture")).toBe(true);
  captures.render();
  expect(batchDraw).toHaveBeenCalledTimes(2);
  vi.spyOn(normalMaterial, "createRenderTargetNormalMaterial").mockImplementation((scene) => new NodeMaterial("Capture Variant", scene));
  captures.setAssets(new Map([["target", { mode: "WorldNormal", width: 16, height: 8 }]]));
  captures.request("capture"); captures.render();
  expect(batchDraw).toHaveBeenCalledTimes(2);
});

it("actor filtering is opt-in, includes component descendants, and an empty list clears the output", () => {
  const { scene, captures, root, settings, draws } = host();
  const selected = new Mesh("Actor A", scene);
  const child = MeshBuilder.CreateBox("Component A", {}, scene); child.parent = selected;
  const other = MeshBuilder.CreateBox("Actor B", {}, scene);
  captures.registerActor("a", () => selected); captures.registerActor("b", () => other);
  captures.request("capture"); captures.render();
  expect(draws[0]).toEqual(expect.arrayContaining([child, other]));
  captures.configure("capture", { ...settings, captureOnlyActors: true, actorIds: ["a"] }, () => root);
  captures.request("capture"); captures.render();
  expect(draws[1]).toEqual([child]);
  captures.configure("capture", { ...settings, captureOnlyActors: true, actorIds: [] }, () => root);
  captures.request("capture"); captures.render();
  expect(draws[2]).toEqual([]);
});

it("excludes a color mesh sampling its own output without excluding unrelated receivers", () => {
  const { scene, captures, draws } = host();
  const output = captures.acquireTexture("texture")!.resource;
  const screen = MeshBuilder.CreatePlane("Screen", {}, scene);
  const material = new StandardMaterial("Screen Material", scene);
  material.emissiveTexture = output; screen.material = material;
  const other = MeshBuilder.CreateBox("Other", {}, scene);
  captures.request("capture"); captures.render();
  captures.request("capture"); captures.render();
  expect(draws[1]).toContain(other);
  expect(draws[1]).not.toContain(screen);
});

it("omits editor grids, camera bounds, debug geometry and pick proxies from world captures", () => {
  const { scene, captures, draws } = host();
  const world = MeshBuilder.CreateBox("World", {}, scene);
  for (const name of [GRID_MESH_NAME, CAMERA_BOUNDS_MESH_NAME, "debugAudio:range", "debugFrustum:camera"])
    MeshBuilder.CreatePlane(name, {}, scene);
  const proxy = MeshBuilder.CreateBox("Actor Pick Proxy", {}, scene); proxy.metadata = { editorPickProxy: true };
  captures.request("capture"); captures.render();
  expect(draws[0]).toEqual([world]);
});

it("retires deleted, disabled and scene-cleared capture outputs without invalidating material wrappers", () => {
  const { captures, root, settings, engine } = host();
  const output = captures.acquireTexture("texture")!.resource;
  captures.request("capture"); captures.render();
  expect(managedRenderReservations(engine).reservedBytes).toBeGreaterThan(0);
  captures.configure("capture", { ...settings, enabled: false }, () => root);
  expect(output.getSize()).toEqual({ width: 1, height: 1 });
  expect(managedRenderReservations(engine).reservedBytes).toBe(4);
  captures.configure("capture", settings, () => root);
  captures.request("capture"); captures.render();
  captures.setAssets(new Map(), new Map());
  expect(output.getSize()).toEqual({ width: 1, height: 1 });
  expect(managedRenderReservations(engine).reservedBytes).toBe(4);
  captures.clear(); captures.dispose();
  expect(managedRenderReservations(engine).reservedBytes).toBe(0);
});

it("filtered captures follow replacement actor roots and exclude attached unselected actors", () => {
  const { scene, captures, root, settings, draws } = host();
  let selected = MeshBuilder.CreateBox("Selected Actor", {}, scene);
  const attached = MeshBuilder.CreateBox("Nested Actor", {}, scene); attached.parent = selected;
  const sibling = MeshBuilder.CreateBox("Sibling Actor", {}, scene);
  captures.registerActor("selected", () => selected);
  captures.registerActor("attached", () => attached);
  captures.registerActor("sibling", () => sibling);
  captures.configure("capture", { ...settings, captureOnlyActors: true, actorIds: ["selected", "missing"] }, () => root);
  captures.request("capture"); captures.render();
  expect(draws[0]).toEqual([selected]);
  const previous = selected;
  attached.parent = null;
  selected = MeshBuilder.CreateBox("Replacement Actor", {}, scene);
  previous.dispose();
  captures.request("capture"); captures.render();
  expect(draws[1]).toEqual([selected]);
});

it("Scene Color particle selection follows emitter actor ownership", () => {
  const { scene, captures, root, settings, particleDraws } = host();
  const selected = new Mesh("Selected Actor", scene);
  const other = new Mesh("Other Actor", scene);
  const included = new ParticleSystem("Selected Particles", 8, scene); included.emitter = selected;
  const excluded = new ParticleSystem("Other Particles", 8, scene); excluded.emitter = other;
  captures.registerActor("selected", () => selected); captures.registerActor("other", () => other);
  captures.request("capture"); captures.render();
  expect(particleDraws[0]).toEqual([included, excluded]);
  captures.configure("capture", { ...settings, captureOnlyActors: true, actorIds: ["selected"] }, () => root);
  captures.request("capture"); captures.render();
  expect(particleDraws[1]).toEqual([included]);
});

it("keeps pending streamed meshes, imports and particles out of parent captures", () => {
  const { scene, captures, draws, particleDraws } = host();
  const parent = MeshBuilder.CreateBox("Parent", {}, scene);
  const parentParticles = new ParticleSystem("Parent Particles", 8, scene);
  const binding = createSnapshotSceneBinding();
  binding.meshes.set(1, parent);
  const admission = createSceneStreamAdmission(scene, binding);
  const identity = { actorGuid: "stream", streamLoadId: 1 };
  admission.receive({ type: "sceneStreamLoading", ...identity });
  admission.receive({ type: "spawn", slotId: 2, actorGuid: "child", classId: "Actor", sceneStreamActorGuid: "stream", streamLoadId: 1 });
  const child = MeshBuilder.CreateBox("Child", {}, scene);
  const pendingImport = MeshBuilder.CreateBox("Unbound Import", {}, scene);
  vi.spyOn(pendingImport, "isReady").mockReturnValue(false);
  binding.meshes.set(2, child);
  const childParticles = new ParticleSystem("Child Particles", 8, scene);
  registerSceneStreamParticle(childParticles, 2);
  admission.sync();
  captures.request("capture"); captures.render();
  expect(draws[0]).toEqual([parent]);
  expect(particleDraws[0]).toEqual([parentParticles]);
  admission.publish([2], identity);
  captures.request("capture"); captures.render();
  expect(draws[1]).toEqual([parent, child]);
  expect(particleDraws[1]).toEqual([parentParticles, childParticles]);
  retirePlaySlot(binding, 2);
  childParticles.dispose(); pendingImport.dispose();
  admission.sync();
  captures.request("capture"); captures.render();
  expect(draws[2]).toEqual([parent]);
  expect(particleDraws[2]).toEqual([parentParticles]);
  admission.clear();
});

it("excludes particles sampling the capture attachment and admits a replacement material", async () => {
  const { scene, captures, particleDraws } = host();
  const document = createDefaultMaterialDocument("Capture Particles", "particle");
  document.nodes.push({ id: "capture", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "texture" } });
  document.edges = [{ id: "capture-color", sourceNodeId: "capture", sourcePinId: "rgba", targetNodeId: "output", targetPinId: "color" }];
  const library = new MaterialLibrary({ acquireTexture: (guid, owner) => captures.acquireTexture(guid, owner) });
  try {
    const feedbackMaterial = library.acquire(scene, "feedback", document);
    const replacement = library.acquire(scene, "replacement", createDefaultMaterialDocument("Replacement", "particle"));
    if (materialUnavailable(feedbackMaterial) || materialUnavailable(replacement)) throw new Error("Particle fixtures must compile");
    await Promise.all([feedbackMaterial.ready, replacement.ready]);
    const feedback = new ParticleSystem("Capture Sampling Particles", 8, scene);
    const ordinary = new ParticleSystem("Ordinary Particles", 8, scene);
    await bindParticleMaterial(feedback, feedbackMaterial.material);

    // The first frame samples the independent blank fallback. Publishing the
    // real output then makes this material unsafe for the next capture.
    captures.request("capture"); captures.render();
    expect(particleDraws[0]).toEqual([feedback, ordinary]);
    captures.request("capture"); captures.render();
    expect(particleDraws[1]).toEqual([ordinary]);

    await bindParticleMaterial(feedback, replacement.material);
    library.release(scene, "feedback");
    captures.request("capture"); captures.render();
    expect(particleDraws[2]).toEqual([feedback, ordinary]);
  } finally { library.dispose(); }
});

it.each(["WorldNormal", "DepthPass"] as const)("filters mixed %s slots per mesh and retires variants no longer captured", (mode) => {
  const { scene, captures, engine } = host();
  engine.getCaps().textureHalfFloatRender = true;
  // Shader output is covered in the real-browser proof; retain real material
  // ownership here without starting asynchronous shader compilation.
  vi.spyOn(normalMaterial, "createRenderTargetNormalMaterial").mockImplementation((scene) => new NodeMaterial("Capture Variant", scene));
  vi.spyOn(normalMaterial, "createRenderTargetDepthMaterial").mockImplementation((scene) => new NodeMaterial("Capture Depth Variant", scene));
  captures.setAssets(new Map([["target", { mode, width: 16, height: 8 }]]));
  const first = new StandardMaterial("First", scene); first.transparencyMode = Material.MATERIAL_OPAQUE;
  const shared = new StandardMaterial("Shared", scene);
  const cutout = new StandardMaterial("Cutout", scene); cutout.transparencyMode = Material.MATERIAL_ALPHATEST;
  const mask = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene);
  mask.hasAlpha = true; cutout.diffuseTexture = mask;
  const blended = new StandardMaterial("Blended", scene); blended.alpha = 0.5;
  const source = new MultiMaterial("Source Slots", scene); source.subMaterials = [first, shared, cutout, blended];
  const mesh = MeshBuilder.CreateBox("Model", {}, scene); mesh.material = source;
  const faded = MeshBuilder.CreateBox("Model With Vertex Alpha", {}, scene); faded.material = source; faded.hasVertexAlpha = true;
  const sibling = MeshBuilder.CreateBox("Sibling", {}, scene); sibling.material = shared;
  captures.request("capture"); captures.render();
  const target = scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture;
  const slots = mesh.getMaterialForRenderPass(target.renderPassId) as MultiMaterial;
  const firstVariant = slots.subMaterials[0]!;
  const sharedVariant = slots.subMaterials[1]!;
  let cutoutVariant = slots.subMaterials[2]!;
  const fadedSlots = faded.getMaterialForRenderPass(target.renderPassId) as MultiMaterial;
  expect(Array.from(slots.subMaterials)).toEqual([firstVariant, sharedVariant, cutoutVariant, null]);
  expect(firstVariant).not.toBeNull();
  expect(sharedVariant).not.toBeNull();
  expect(cutoutVariant).not.toBeNull();
  expect(fadedSlots).not.toBe(slots);
  expect(Array.from(fadedSlots.subMaterials)).toEqual([firstVariant, null, cutoutVariant, null]);
  expect(Array.from(source.subMaterials)).toEqual([first, shared, cutout, blended]);
  mask.coordinatesIndex = 1;
  captures.request("capture"); captures.render();
  expect(scene.materials).not.toContain(cutoutVariant);
  expect(slots.subMaterials[1]).toBe(sharedVariant);
  cutoutVariant = slots.subMaterials[2]!;
  expect(cutoutVariant).not.toBeNull();
  expect(fadedSlots.subMaterials[2]).toBe(cutoutVariant);
  source.subMaterials = [new StandardMaterial("Replacement", scene)];
  captures.request("capture"); captures.render();
  expect(scene.materials).not.toContain(firstVariant);
  expect(scene.materials).not.toContain(cutoutVariant);
  expect(scene.materials).toContain(sharedVariant);
  expect(scene.multiMaterials).not.toContain(fadedSlots);
  expect(faded.getMaterialForRenderPass(target.renderPassId)).toBeUndefined();
  expect(slots.subMaterials).toHaveLength(1);
  expect(slots.subMaterials[0]).not.toBe(firstVariant);
  sibling.dispose();
  captures.request("capture"); captures.render();
  expect(scene.materials).not.toContain(sharedVariant);
  captures.clear();
  expect(scene.multiMaterials).not.toContain(slots);
});

it("admits no GPU target or draw when the shared rendering ceiling cannot fit it", () => {
  const { captures, engine, draws } = host();
  limitManagedRenderBytes(engine, 16);
  captures.request("capture"); captures.render();
  expect(draws).toEqual([]);
  expect(managedRenderReservations(engine).reservedBytes).toBe(0);
});

it.each(["readiness", "draw"] as const)("restores rendering state and can retry when native capture %s throws", (stage) => {
  const { captures, scene, engine, camera } = host(true);
  camera.position.x = 1000;
  const sibling = new Scene(engine, { useFloatingOrigin: true });
  new FreeCamera("Sibling Camera", new Vector3(-2000, 0, -5), sibling);
  const previousScene = FloatingOriginCurrentScene.getScene;
  FloatingOriginCurrentScene.eyeAtCamera = false;
  vi.mocked(RenderTargetTexture.prototype.isReadyForRendering).mockRestore();
  vi.mocked(RenderTargetTexture.prototype.render).mockRestore();
  const borrowed = engine.createRenderTargetTexture(8, {});
  const interrupted = engine.createRenderTargetTexture(4, {});
  engine.bindFramebuffer(borrowed);
  const viewport = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 };
  engine.setViewport(viewport, 8, 8);
  engine.setAlphaMode(Constants.ALPHA_ADD);
  engine.setDepthBuffer(false); engine.setDepthWrite(false);
  engine.setColorWrite(false);
  const renderPass = engine.currentRenderPassId;
  scene.imageProcessingConfiguration.applyByPostProcess = true;
  const outlines = scene.getOutlineRenderer(); outlines.enabled = true;
  const output = captures.acquireTexture("texture")!.resource;
  const fail = () => {
    expect(FloatingOriginCurrentScene.getScene()).toBe(scene);
    expect(FloatingOriginCurrentScene.eyeAtCamera).toBe(true);
    expect(scene.activeCamera).not.toBe(camera);
    expect(scene.floatingOriginOffset.equals(Vector3.ZeroReadOnly)).toBe(true);
    expect(engine.getDepthBuffer()).toBe(true);
    expect(engine.getDepthWrite()).toBe(true);
    expect(engine.getAlphaMode()).toBe(Constants.ALPHA_DISABLE);
    expect(engine.getColorWrite()).toBe(true);
    engine.bindFramebuffer(interrupted);
    engine.setDepthBuffer(false); engine.setDepthWrite(false);
    engine.setAlphaMode(Constants.ALPHA_ADD);
    engine.currentRenderPassId = 47;
    throw new Error("GPU capture failed");
  };
  const cleanup: Array<() => void> = [];
  const initialize = ObjectRenderer.prototype.initRender;
  const initialization = vi.spyOn(ObjectRenderer.prototype, "initRender").mockImplementation(function (this: ObjectRenderer, width, height) {
    initialize.call(this, width, height);
    if (stage === "readiness") fail();
    else if (!cleanup.length) {
      const observer = this.onBeforeRenderingManagerRenderObservable.add(fail);
      cleanup.push(() => { this.onBeforeRenderingManagerRenderObservable.remove(observer); });
    }
  });
  captures.request("capture");
  expect(() => captures.render()).toThrow("GPU capture failed");
  expect(scene.activeCamera).toBe(camera);
  expect(engine.currentRenderPassId).toBe(renderPass);
  expect(engine._currentRenderTarget).toBe(borrowed);
  expect(engine.currentViewport).toEqual(viewport);
  expect(engine.getDepthBuffer()).toBe(false);
  expect(engine.getDepthWrite()).toBe(false);
  expect(engine.getAlphaMode()).toBe(Constants.ALPHA_ADD);
  expect(engine.getColorWrite()).toBe(false);
  expect(outlines.enabled).toBe(true);
  expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(true);
  expect(FloatingOriginCurrentScene.getScene).toBe(previousScene);
  expect(FloatingOriginCurrentScene.eyeAtCamera).toBe(false);
  initialization.mockRestore();
  for (const remove of cleanup) remove();
  captures.render();
  expect(output.getSize().width).toBe(16);
  expect(FloatingOriginCurrentScene.getScene).toBe(previousScene);
  expect(FloatingOriginCurrentScene.eyeAtCamera).toBe(false);
  borrowed.dispose(); interrupted.dispose();
});
