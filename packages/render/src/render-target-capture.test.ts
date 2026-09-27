import {
  Constants, FreeCamera, Mesh, MeshBuilder, NullEngine, ParticleSystem, RenderTargetTexture,
  Scene, StandardMaterial, Vector3,
} from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultRenderTargetCaptureProperties } from "@babylonslate/core";
import { RenderTargetCaptures } from "./render-target-capture";
import { managedRenderReservations, limitManagedRenderBytes } from "./managed-render-resources";
import { GRID_MESH_NAME, CAMERA_BOUNDS_MESH_NAME } from "./editor-grid";

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
});
