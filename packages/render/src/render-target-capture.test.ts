import {
  Constants, FreeCamera, HemisphericLight, LightConstants, Material, Mesh, MeshBuilder, MultiMaterial, NodeMaterial, NullEngine, ObjectRenderer, ParticleSystem, RenderTargetTexture,
  Scene, StandardMaterial, Vector3,
} from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultRenderTargetCaptureProperties } from "@babylonslate/core";
import { RenderTargetCaptures } from "./render-target-capture";
import { managedRenderReservations, limitManagedRenderBytes } from "./managed-render-resources";
import { GRID_MESH_NAME, CAMERA_BOUNDS_MESH_NAME } from "./editor-grid";
import * as normalMaterial from "./render-target-normal-material";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  // NullEngine does not record the GPU allocator's format metadata.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
    return target;
  });
  const scene = new Scene(engine);
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
  const update = vi.fn((_camera: { name: string } | null) => ({ render: batchDraw }));
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
  const attached = MeshBuilder.CreateBox("Other Actor", {}, scene); attached.parent = selected;
  captures.registerActor("selected", () => selected); captures.registerActor("other", () => attached);
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

it("filters mixed normal slots per mesh and retires variants no longer captured", () => {
  const { scene, captures } = host();
  // Shader output is covered in the real-browser proof; retain real material
  // ownership here without starting asynchronous shader compilation.
  vi.spyOn(normalMaterial, "createRenderTargetNormalMaterial").mockImplementation((scene) => new NodeMaterial("Capture Variant", scene));
  captures.setAssets(new Map([["target", { mode: "WorldNormal", width: 16, height: 8 }]]));
  const first = new StandardMaterial("First", scene); first.transparencyMode = Material.MATERIAL_OPAQUE;
  const shared = new StandardMaterial("Shared", scene);
  const cutout = new StandardMaterial("Cutout", scene); cutout.transparencyMode = Material.MATERIAL_ALPHATEST;
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
  const cutoutVariant = slots.subMaterials[2]!;
  const fadedSlots = faded.getMaterialForRenderPass(target.renderPassId) as MultiMaterial;
  expect(slots.subMaterials).toEqual([firstVariant, sharedVariant, cutoutVariant, null]);
  expect(firstVariant).not.toBeNull();
  expect(sharedVariant).not.toBeNull();
  expect(cutoutVariant).not.toBeNull();
  expect(fadedSlots).not.toBe(slots);
  expect(fadedSlots.subMaterials).toEqual([firstVariant, null, cutoutVariant, null]);
  expect(source.subMaterials).toEqual([first, shared, cutout, blended]);
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

it("restores camera, render pass and the borrowed target when a capture draw throws", () => {
  const { captures, scene, engine, camera } = host();
  const renderPass = engine.currentRenderPassId;
  const target = engine._currentRenderTarget;
  scene.imageProcessingConfiguration.applyByPostProcess = true;
  vi.mocked(RenderTargetTexture.prototype.render).mockImplementation(function (this: RenderTargetTexture) {
    scene.activeCamera = this.activeCamera;
    engine.currentRenderPassId = 47;
    throw new Error("GPU capture failed");
  });
  captures.request("capture");
  expect(() => captures.render()).toThrow("GPU capture failed");
  expect(scene.activeCamera).toBe(camera);
  expect(engine.currentRenderPassId).toBe(renderPass);
  expect(engine._currentRenderTarget).toBe(target);
  expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(true);
});
