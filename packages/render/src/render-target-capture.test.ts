import { setSceneGameTimePaused } from "./scene-game-time";
import { Constants } from "@babylonjs/core/Engines/constants";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Material } from "@babylonjs/core/Materials/material";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture";
// Registers the scene's outline renderer, which the test enables.
import "@babylonjs/core/Rendering/outlineRenderer";
import { createDefaultRenderTargetCaptureProperties } from "@haptic/core";
import { RenderTargetCaptures } from "./render-target-capture";
import { notePassListed } from "./pass-list-signal";
import { DisplayConversion } from "./display-conversion";
import { createStartingStateDraw } from "./starting-state-draw";
import { managedRenderReservations, limitManagedRenderBytes } from "./managed-render-resources";
import { renderTargetAllocationBytes } from "./render-target-resource-cost";
import { GRID_MESH_NAME, CAMERA_BOUNDS_MESH_NAME } from "./editor-grid";
import * as normalMaterial from "./render-target-normal-material";
import { createDefaultMaterialDocument } from "@haptic/shader-graph";
import { MaterialLibrary, materialUnavailable } from "./material-library";
import { bindParticleMaterial } from "./particle-system-factory";
import { createSceneStreamAdmission, registerSceneStreamParticle } from "./scene-stream-admission";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";
import { acquireAuthoredMaterialVariant } from "./material-compiler";
import { disposeMeshLatticeDeformer, setMeshLatticeDeformer } from "./lattice-deformer";
import { applyEditorMaterialFreeze } from "./scene-perf";
import { beginPipelineDeferral } from "./webgpu-pipeline-deferral";

// NullEngine is not WebGPU, so the deferral itself never engages; its scopes are the seam here.
vi.mock("./webgpu-pipeline-deferral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webgpu-pipeline-deferral")>();
  return { ...actual, beginPipelineDeferral: vi.fn(actual.beginPipelineDeferral) };
});
const { beginPipelineDeferral: actualBeginPipelineDeferral } =
  await vi.importActual<typeof import("./webgpu-pipeline-deferral")>("./webgpu-pipeline-deferral");

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(beginPipelineDeferral).mockImplementation(actualBeginPipelineDeferral);
  for (const engine of engines.splice(0)) engine.dispose();
});
function host(floatingOrigin = false) {
  const engine = new NullEngine();
  if (floatingOrigin) vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  engines.push(engine);
  // NullEngine does not record the GPU allocator's format metadata.
  const allocate = engine.createRenderTargetTexture.bind(engine);
  vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
    const target = allocate(size, options);
    target.texture!.format = (typeof options === "object" ? options.format : undefined) ?? Constants.TEXTUREFORMAT_RGBA;
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
  // The pass that stores a colour capture's drawn image compiles in a browser: here it is ready, and recorded.
  let linearSource = false;
  vi.spyOn(DisplayConversion.prototype, "ready").mockImplementation((linear) => { linearSource = linear; return true; });
  const stored: Array<{ from: string; into: string | undefined; linear: boolean; texture: unknown }> = [];
  vi.spyOn(DisplayConversion.prototype, "draw").mockImplementation((source) => {
    const into = scene.textures.find((texture) => (texture as RenderTargetTexture).renderTarget === engine._currentRenderTarget);
    stored.push({ from: source.name, into: into?.name, linear: linearSource, texture: into?.getInternalTexture() });
  });
  const draws: Array<readonly Mesh[]> = [];
  const particleDraws: unknown[][] = [];
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    draws.push([...(this.renderList ?? [])] as Mesh[]);
    particleDraws.push([...(this.particleSystemList ?? [])]);
  });
  return { engine, scene, camera, captures, root, settings, draws, particleDraws, stored };
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

const texture = (scene: Scene, name: string) => scene.textures.find((entry) => entry.name === name) as RenderTargetTexture | undefined;
const colourBytes = (type: number) => renderTargetAllocationBytes({ width: 16, height: 8, format: Constants.TEXTUREFORMAT_RGBA, type });

it.each([
  ["a Scene Linear", true, Constants.TEXTURETYPE_HALF_FLOAT],
  ["any other", false, Constants.TEXTURETYPE_UNSIGNED_BYTE],
] as const)("draws a Fast colour capture with %s view's own programs, then stores it display-referred in its output", (_view, linear, type) => {
  const { scene, engine, captures, stored } = host();
  scene.imageProcessingConfiguration.applyByPostProcess = linear;
  const output = captures.acquireTexture("texture")!.resource;
  const drawn: Array<{ name: string; programs: boolean }> = [];
  vi.mocked(RenderTargetTexture.prototype.render).mockImplementation(function (this: RenderTargetTexture) {
    // What the Scene's Materials compile for while the pass draws: the view's own setting.
    drawn.push({ name: this.name, programs: scene.imageProcessingConfiguration.applyByPostProcess });
  });
  captures.request("capture"); captures.render();
  expect(drawn).toEqual([{ name: "renderTarget:target:scene", programs: linear }]);
  const pass = texture(scene, "renderTarget:target:scene")!, published = texture(scene, "renderTarget:target")!;
  expect(stored).toEqual([{ from: "renderTarget:target:scene", into: "renderTarget:target", linear, texture: published.getInternalTexture() }]);
  expect(output.getInternalTexture()).toBe(published.getInternalTexture());
  // The pass has the depth and, for linear colour, the range; the output holds display colour alone.
  expect([pass.getInternalTexture()!.type, pass.renderTarget!._generateDepthBuffer]).toEqual([type, true]);
  expect([published.getInternalTexture()!.type, published.renderTarget!._generateDepthBuffer]).toEqual([Constants.TEXTURETYPE_UNSIGNED_BYTE, false]);
  expect([published.gammaSpace, pass.gammaSpace]).toEqual([true, !linear]);
  // (The headless Engine makes no depth buffer to count.)
  expect(managedRenderReservations(engine).reservedBytes).toBe(4 + colourBytes(Constants.TEXTURETYPE_UNSIGNED_BYTE) + colourBytes(type));
  const released = vi.spyOn(DisplayConversion.prototype, "dispose");
  captures.dispose();
  expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  expect(texture(scene, "renderTarget:target:scene")).toBeUndefined();
  expect(released).toHaveBeenCalledTimes(1);
});

it("admits no colour capture whose pass the shared rendering ceiling cannot fit beside its output", () => {
  const { scene, captures, engine, draws } = host();
  // Room for the output alone.
  limitManagedRenderBytes(engine, colourBytes(Constants.TEXTURETYPE_UNSIGNED_BYTE) + 16 * 8 * 5);
  captures.request("capture"); captures.render();
  expect(draws).toEqual([]);
  expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  expect(texture(scene, "renderTarget:target")).toBeUndefined();
});

it("makes a Fast colour capture's pass anew when the view's programs change what they write", () => {
  const { scene, captures, stored } = host();
  captures.request("capture"); captures.render();
  const first = texture(scene, "renderTarget:target:scene")!;
  expect(first.getInternalTexture()!.type).toBe(Constants.TEXTURETYPE_UNSIGNED_BYTE);
  scene.imageProcessingConfiguration.applyByPostProcess = true;
  captures.request("capture"); captures.render();
  const passes = scene.textures.filter((entry) => entry.name === "renderTarget:target:scene");
  expect(passes).toHaveLength(1);
  expect(passes[0]).not.toBe(first);
  expect(passes[0]!.getInternalTexture()!.type).toBe(Constants.TEXTURETYPE_HALF_FLOAT);
  expect(stored.map((entry) => entry.linear)).toEqual([false, true]);
});

it("keeps a colour capture's request and last image while the pass that stores it compiles", () => {
  const { captures, draws, stored } = host();
  const output = captures.acquireTexture("texture")!.resource;
  vi.mocked(DisplayConversion.prototype.ready).mockReturnValue(false);
  captures.request("capture"); captures.render();
  expect([draws.length, stored.length]).toEqual([0, 0]);
  expect(output.getSize()).toEqual({ width: 1, height: 1 });
  vi.mocked(DisplayConversion.prototype.ready).mockReturnValue(true);
  captures.render();
  expect([draws.length, stored.length]).toEqual([1, 1]);
  expect(output.getSize()).toEqual({ width: 16, height: 8 });
});

it("draws a data capture's override Materials straight into its output", () => {
  const { scene, captures, draws, stored, root, settings } = host();
  captures.setAssets(new Map([["target", { mode: "DepthPass", width: 16, height: 8 }]]), new Map([["texture", { renderTargetGuid: "target" }]]));
  captures.configure("capture", settings, () => root);
  vi.spyOn(scene.getEngine().getCaps(), "textureHalfFloatRender", "get").mockReturnValue(true);
  captures.request("capture"); captures.render();
  expect(draws).toHaveLength(1);
  expect(stored).toEqual([]);
  expect(texture(scene, "renderTarget:target:scene")).toBeUndefined();
  expect(texture(scene, "renderTarget:target")!.renderTarget!._generateDepthBuffer).toBe(true);
});

it("suspends every-frame captures without releasing them, while manual requests still draw", () => {
  const { captures, draws, settings, root } = host();
  const output = captures.acquireTexture("texture")!.resource;
  captures.configure("capture", { ...settings, captureEveryFrame: true }, () => root);
  captures.render();
  expect(draws).toHaveLength(1);
  const published = output.getInternalTexture();
  captures.setEveryFrameSuspended(true);
  captures.render(); captures.render();
  expect(draws).toHaveLength(1);
  // The output keeps its last image and storage while suspended.
  expect(output.getInternalTexture()).toBe(published);
  captures.configure("manual", { ...settings, renderTargetGuid: "other", captureEveryFrame: false }, () => root);
  captures.setAssets(new Map([["target", { mode: "SceneColor", width: 16, height: 8 }], ["other", { mode: "SceneColor", width: 16, height: 8 }]]),
    new Map([["texture", { renderTargetGuid: "target" }]]));
  captures.request("manual"); captures.render();
  expect(draws).toHaveLength(2);
  captures.setEveryFrameSuspended(false);
  captures.render();
  // The every-frame capture draws again; the manual one waits for its next request.
  expect(draws).toHaveLength(3);
});

it("stores and publishes nothing, and keeps a manual request, while its draw waits for a compiling pipeline", () => {
  const { captures, draws, stored } = host();
  const output = captures.acquireTexture("texture")!.resource;
  captures.request("capture");
  // Inside a deferring view's frame, a draw skipped for a pipeline still compiling.
  vi.mocked(beginPipelineDeferral).mockImplementation(() => ({ close: () => 1, waiting: () => true, warmed: () => false }));
  captures.render();
  expect(draws).toHaveLength(1);
  // The pass lacks a mesh: its image never reaches the output, which keeps what it held.
  expect(stored).toHaveLength(0);
  expect(output.getSize()).not.toEqual({ width: 16, height: 8 });
  vi.mocked(beginPipelineDeferral).mockImplementation(actualBeginPipelineDeferral);
  captures.render();
  expect(draws).toHaveLength(2);
  expect(stored).toHaveLength(1);
  expect(output.getSize()).toEqual({ width: 16, height: 8 });
  captures.render();
  expect(draws).toHaveLength(2);
});

it("stores a Depth Pass capture as one half-float channel, charged at two bytes a pixel", () => {
  const { scene, captures, engine, draws } = host();
  engine.getCaps().textureHalfFloatRender = true;
  vi.spyOn(normalMaterial, "createRenderTargetDepthMaterial").mockImplementation((scene) => new NodeMaterial("Capture Depth Variant", scene));
  captures.setAssets(new Map([["target", { mode: "DepthPass", width: 16, height: 8 }]]), new Map([["texture", { renderTargetGuid: "target" }]]));
  MeshBuilder.CreateBox("Model", {}, scene).material = new StandardMaterial("Source", scene);
  captures.acquireTexture("texture");
  // Beside the shared 1 × 1 data fallback.
  const fallback = managedRenderReservations(engine).categoryBytes.geometry;
  captures.request("capture"); captures.render();
  expect(draws).toHaveLength(1);
  const target = scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture;
  // Only red carries depth: an R16F target samples as the (d, 0, 0, 1) the capture writes and clears.
  expect([target.getInternalTexture()!.format, target.getInternalTexture()!.type])
    .toEqual([Constants.TEXTUREFORMAT_R, Constants.TEXTURETYPE_HALF_FLOAT]);
  expect(target.clearColor.asArray()).toEqual([1, 0, 0, 1]);
  // 16 × 8 pixels at 2 bytes, where RGBA16F took 8.
  expect(managedRenderReservations(engine).categoryBytes.geometry - fallback).toBe(16 * 8 * 2);
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

it("draws a capture that samples itself into its own pass, and stores the image in the one output afterwards", () => {
  const { scene, captures, draws, engine, stored } = host();
  const output = captures.acquireTexture("texture")!.resource;
  const fallback = output.getInternalTexture();
  const screen = MeshBuilder.CreatePlane("Screen", {}, scene);
  const material = new StandardMaterial("Screen Material", scene);
  material.emissiveTexture = output; screen.material = material;
  const other = MeshBuilder.CreateBox("Other", {}, scene);
  // What the screen samples while each pass draws, and what that pass draws into.
  const sampled: unknown[] = [], passes: string[] = [];
  const draw = vi.mocked(RenderTargetTexture.prototype.render).getMockImplementation()!;
  vi.mocked(RenderTargetTexture.prototype.render).mockImplementation(function (this: RenderTargetTexture) {
    sampled.push(output.getInternalTexture());
    passes.push(this.name);
    draw.call(this);
  });
  captures.request("capture"); captures.render();
  const first = output.getInternalTexture();
  const bytes = managedRenderReservations(engine).reservedBytes;
  // A completed material keeps its shader state: the output it samples never changes again.
  const dirty = vi.spyOn(material, "markDirty");
  for (let frame = 0; frame < 2; frame++) { captures.request("capture"); captures.render(); }
  expect(draws).toHaveLength(3);
  expect(draws[1]).toEqual(expect.arrayContaining([other, screen]));
  // Each pass draws into the scene colour target while the screen shows the last stored image.
  expect(passes).toEqual(Array(3).fill("renderTarget:target:scene"));
  expect(sampled).toEqual([fallback, first, first]);
  // Only then is the image stored, in the output itself: no second buffer, no swap.
  expect(stored.map((entry) => [entry.into, entry.texture])).toEqual(Array(3).fill(["renderTarget:target", first]));
  expect(output.getInternalTexture()).toBe(first);
  expect(scene.textures.map((entry) => entry.name).filter((name) => name?.startsWith("renderTarget:target")).sort())
    .toEqual(["renderTarget:target", "renderTarget:target:scene"]);
  expect(managedRenderReservations(engine).reservedBytes).toBe(bytes);
  expect(dirty).not.toHaveBeenCalled();
  captures.render();
  expect(draws).toHaveLength(3);
  captures.clear();
  expect(output.getSize()).toEqual({ width: 1, height: 1 });
  expect(managedRenderReservations(engine).reservedBytes).toBe(4);
  captures.dispose();
  expect(managedRenderReservations(engine).reservedBytes).toBe(0);
});

it("keeps the last stored image, and the request, while a capture's pass is not ready or fails", () => {
  const { captures, draws, stored } = host();
  const output = captures.acquireTexture("texture")!.resource;
  captures.request("capture"); captures.render();
  const first = output.getInternalTexture();
  captures.request("capture");
  vi.mocked(RenderTargetTexture.prototype.isReadyForRendering).mockReturnValueOnce(false);
  captures.render();
  expect([draws.length, stored.length]).toEqual([1, 1]);
  vi.mocked(RenderTargetTexture.prototype.render).mockImplementationOnce(() => { throw new Error("Interrupted capture"); });
  expect(() => captures.render()).toThrow("Interrupted capture");
  // The pass threw before anything was stored.
  expect(stored).toHaveLength(1);
  captures.render();
  expect([draws.length, stored.length]).toEqual([2, 2]);
  expect(output.getInternalTexture()).toBe(first);
});

it("draws only what a Fast capture's camera sees, at its target's shape", () => {
  const { scene, captures, draws, root, settings } = host();
  // The capture looks along +z from the origin, 60 degrees tall, into a target twice as wide as tall.
  captures.configure("capture", { ...settings, fieldOfView: 60 }, () => root);
  const at = (name: string, x: number, z: number) => {
    const mesh = MeshBuilder.CreateBox(name, {}, scene);
    mesh.position.set(x, 0, z);
    return mesh;
  };
  const ahead = at("ahead", 0, 10), behind = at("behind", 0, -10), beside = at("beside", 30, 10);
  // Inside the view at its width; a view as wide as tall would end before it.
  at("wide", 8.5, 10);
  // What follows the camera, and what is marked always drawn, pass whatever the view.
  const sky = at("sky", 0, -10); sky.infiniteDistance = true;
  const marked = at("marked", 0, -10); marked.alwaysSelectAsActiveMesh = true;
  // Babylon draws a system only while its emitter is in the pass's list: it stays though it is behind the camera.
  const emitter = new Mesh("emitter", scene); emitter.position.z = -10;
  new ParticleSystem("particles", 8, scene).emitter = emitter;
  // A frame's passes move the Scene's render id on, under which a mesh compares its transform again.
  const drawn = () => { scene.incrementRenderId(); captures.request("capture"); captures.render(); return draws.at(-1)!.map((mesh) => mesh.name).sort(); };
  expect(drawn()).toEqual(["ahead", "emitter", "marked", "sky", "wide"]);
  // A move made since counts.
  behind.position.z = 10;
  ahead.position.z = -10;
  expect(drawn()).toEqual(["behind", "emitter", "marked", "sky", "wide"]);
  // The capture's own pose too.
  root.rotation.y = Math.PI;
  expect(drawn()).toEqual(["ahead", "emitter", "marked", "sky"]);
  // Never seen, never drawn.
  expect(draws.flat()).not.toContain(beside);
});

it("captures another target's output without allocating feedback storage", () => {
  const { scene, captures, root, settings, engine, draws } = host();
  captures.setAssets(new Map([
    ["target", { mode: "SceneColor", width: 16, height: 8 }],
    ["other", { mode: "SceneColor", width: 16, height: 8 }],
  ]), new Map([["texture", { renderTargetGuid: "other" }]]));
  captures.configure("other capture", { ...settings, renderTargetGuid: "other", captureOnlyActors: true, actorIds: [] }, () => root);
  const screen = MeshBuilder.CreatePlane("Screen", {}, scene);
  const material = new StandardMaterial("Screen Material", scene);
  material.emissiveTexture = captures.acquireTexture("texture")!.resource; screen.material = material;
  captures.request("other capture"); captures.render();
  captures.request("capture"); captures.render();
  const used = managedRenderReservations(engine).reservedBytes;
  captures.request("capture"); captures.render();
  expect(draws.at(-1)).toContain(screen);
  expect(managedRenderReservations(engine).reservedBytes).toBe(used);
  captures.clear();
  expect(managedRenderReservations(engine).reservedBytes).toBe(4);
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

it("captures particles sampling the previous capture and admits a replacement material", async () => {
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

    // Both the fallback and the previous completed output are safe to sample.
    captures.request("capture"); captures.render();
    expect(particleDraws[0]).toEqual([feedback, ordinary]);
    captures.request("capture"); captures.render();
    expect(particleDraws[1]).toEqual([feedback, ordinary]);

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

it.each(["WorldNormal", "DepthPass"] as const)("keeps a steady %s capture's draw wrappers, resetting a mesh's only when its variant or a slot changes", (mode) => {
  const { scene, captures, engine } = host();
  engine.getCaps().textureHalfFloatRender = true;
  vi.spyOn(normalMaterial, "createRenderTargetNormalMaterial").mockImplementation((scene) => new NodeMaterial("Capture Variant", scene));
  vi.spyOn(normalMaterial, "createRenderTargetDepthMaterial").mockImplementation((scene) => new NodeMaterial("Capture Depth Variant", scene));
  captures.setAssets(new Map([["target", { mode, width: 16, height: 8 }]]));
  const opaque = new StandardMaterial("Opaque", scene);
  const blended = new StandardMaterial("Blended", scene); blended.alpha = 0.5;
  const slots = new MultiMaterial("Slots", scene); slots.subMaterials = [opaque, opaque];
  const single = MeshBuilder.CreateBox("Single", {}, scene); single.material = opaque;
  const multi = MeshBuilder.CreateBox("Multi", {}, scene); multi.material = slots;
  const capture = () => { captures.request("capture"); captures.render(); };
  capture();
  const pass = (scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture).renderPassId;
  // The pass's draws (mocked here) hold a wrapper per submesh: its program and defines.
  const wrappers = () => [single, multi].map((mesh) => mesh.subMeshes[0]!._getDrawWrapper(pass, true)!);
  let drawn = wrappers();
  const kept = () => wrappers().map((wrapper, index) => wrapper === drawn[index]);
  capture();
  capture();
  expect(kept()).toEqual([true, true]);
  // A blended slot changes the slot container's children (it draws nothing there): that mesh's pass draws them anew.
  slots.subMaterials = [opaque, blended];
  capture();
  expect(Array.from((multi.getMaterialForRenderPass(pass) as MultiMaterial).subMaterials)[1]).toBeNull();
  expect(kept()).toEqual([true, false]);
  drawn = wrappers();
  // Another Material is another variant, for that mesh alone.
  single.material = new StandardMaterial("Replacement", scene);
  capture();
  expect(single.getMaterialForRenderPass(pass)).not.toBe((multi.getMaterialForRenderPass(pass) as MultiMaterial).subMaterials[0]);
  expect(kept()).toEqual([false, true]);
});

it.each(["WorldNormal", "DepthPass"] as const)("prepares a frozen authored %s variant's kept draw wrapper again when a lattice cage on its mesh attaches or detaches in place", async (mode) => {
  const { scene, captures, engine } = host();
  const caps = engine.getCaps();
  caps.textureHalfFloatRender = true; caps.textureFloat = true; caps.maxVertexTextureImageUnits = 16;
  vi.spyOn(engine, "webGLVersion", "get").mockReturnValue(2);
  // NullEngine has no 3D texture backend; the cage's lattice data replaces only that allocation and upload.
  vi.spyOn(engine, "createRawTexture3D").mockImplementation((_data, width, height, depth) => {
    const texture = new InternalTexture(engine, InternalTextureSource.Raw3D);
    texture.width = width; texture.height = height; texture.depth = depth; texture.isReady = true;
    return texture;
  });
  vi.spyOn(engine, "updateRawTexture3D").mockImplementation(() => {});
  // As on WebGPU, each Material owns a context: a dirty call reaches only the draw wrappers holding its own. (WebGL has
  // none, so the main pass's Material marking itself dirty there also reaches the capture pass's wrappers by chance.)
  let contexts = 0;
  vi.spyOn(engine, "createMaterialContext").mockImplementation(() => ({ uniqueId: ++contexts, useVertexPulling: false, reset() {} }));
  const library = new MaterialLibrary();
  try {
    const source = library.acquire(scene, "source", createDefaultMaterialDocument("Deformed Capture"));
    if (!source.ok) throw new Error(JSON.stringify(source.diagnostics));
    expect(await source.ready).toEqual([]);
    const root = new Mesh("Deformed Component", scene);
    const mesh = MeshBuilder.CreateBox("Deformed Part", { size: 2 }, scene);
    mesh.parent = root; mesh.material = source.material;
    captures.setAssets(new Map([["target", { mode, width: 16, height: 8 }]]));
    const capture = () => { captures.request("capture"); captures.render(); };
    capture();
    const pass = (scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture).renderPassId;
    const variant = acquireAuthoredMaterialVariant(source.material, mode === "DepthPass" ? "captureDepth" : "captureNormal")!;
    expect(await variant.compiled.ready).toEqual([]);
    expect(mesh.getMaterialForRenderPass(pass)).toBe(variant.compiled.material);
    const subMesh = mesh.subMeshes[0]!;
    // The pass's draw (mocked here) asks its material whether the submesh is ready, under the pass's id, once per frame.
    const draw = async () => {
      const main = engine.currentRenderPassId;
      engine.currentRenderPassId = pass;
      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          scene.incrementRenderId();
          if (subMesh.getMaterial()!.isReadyForSubMesh(mesh, subMesh, false)) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally { engine.currentRenderPassId = main; }
      const wrapper = subMesh._getDrawWrapper(pass)!;
      return { wrapper, lattice: String(wrapper.defines).includes("#define SLATE_LATTICE") };
    };
    const first = await draw();
    expect(first.lattice).toBe(false);
    // The editor freezes every library Material it is not editing, and a variant is never one it edits.
    applyEditorMaterialFreeze(scene, new Set(["source"]));
    expect(variant.compiled.material.isFrozen).toBe(true);
    capture(); await draw();
    // A cage keeps the mesh and its Material: only the pass's defines can follow it.
    setMeshLatticeDeformer(root, {
      enabled: true, resolution: [2, 2, 2], strength: 1, offsets: Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? 2 : 0),
      fitToMesh: true, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1],
    });
    capture();
    const deformed = await draw();
    expect(deformed.wrapper).toBe(first.wrapper);
    expect(deformed.lattice).toBe(true);
    disposeMeshLatticeDeformer(root);
    capture();
    const restored = await draw();
    expect(restored.wrapper).toBe(first.wrapper);
    expect(restored.lattice).toBe(false);
    await variant.release();
    captures.clear();
  } finally { library.dispose(); }
});

it.each(["WorldNormal", "DepthPass"] as const)("borrows retained authored %s geometry and releases only its capture lease on replacement", async (mode) => {
  const { scene, captures, engine } = host();
  engine.getCaps().textureHalfFloatRender = true;
  const library = new MaterialLibrary();
  try {
    const graph = createDefaultMaterialDocument("Displaced Capture");
    graph.nodes.find((node) => node.type === "output.surface")!.properties["default:worldPositionOffset"] = [0, 0, 2];
    const source = library.acquire(scene, "source", graph);
    if (!source.ok) throw new Error(JSON.stringify(source.diagnostics));
    expect(await source.ready).toEqual([]);
    const mesh = MeshBuilder.CreateBox("Authored Caster", {}, scene);
    mesh.material = source.material;
    captures.setAssets(new Map([["target", { mode, width: 16, height: 8 }]]));
    captures.request("capture"); captures.render();
    const target = scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture;
    const borrowed = acquireAuthoredMaterialVariant(source.material, mode === "DepthPass" ? "captureDepth" : "captureNormal")!;
    expect(await borrowed.compiled.ready).toEqual([]);
    expect(mesh.getMaterialForRenderPass(target.renderPassId)).toBe(borrowed.compiled.material);
    mesh.material = new StandardMaterial("Replacement", scene);
    captures.request("capture"); captures.render();
    expect(mesh.getMaterialForRenderPass(target.renderPassId)).not.toBe(borrowed.compiled.material);
    await Promise.resolve(); await Promise.resolve();
    expect(scene.materials).toContain(borrowed.compiled.material);
    await borrowed.release();
    expect(scene.materials).not.toContain(borrowed.compiled.material);
    captures.clear();
  } finally { library.dispose(); }
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


it("defers periodic and accepted manual captures throughout render-only pause", () => {
  const { scene, captures, draws, root, settings } = host();
  captures.configure("capture", { ...settings, captureEveryFrame: true }, () => root);
  captures.render();
  expect(draws).toHaveLength(1);
  setSceneGameTimePaused(scene, true);
  captures.render();
  expect(draws).toHaveLength(1);
  captures.configure("capture", { ...settings, captureEveryFrame: false }, () => root);
  captures.request("capture");
  captures.render();
  expect(draws).toHaveLength(1);
  setSceneGameTimePaused(scene, false);
  captures.render();
  expect(draws).toHaveLength(2);
  captures.render();
  expect(draws).toHaveLength(2);
});

describe("a rehearsal whose first try does not draw, in Play's starting state", () => {
  /**
   * The starting state as Play wires it: its frames draw the view, whose frame draws the captures, and they draw again
   * while a rehearsal waits (`drawAgain`).
   */
  function startingState() {
    const setup = host();
    const { scene, captures, engine } = setup;
    engine.getCaps().textureHalfFloatRender = true;
    vi.spyOn(normalMaterial, "createRenderTargetDepthMaterial").mockImplementation((scene) => new NodeMaterial("Capture Depth Variant", scene));
    captures.setAssets(new Map([["target", { mode: "DepthPass", width: 16, height: 8 }]]), new Map([["texture", { renderTargetGuid: "target" }]]));
    const mesh = MeshBuilder.CreateBox("Model", {}, scene); mesh.material = new StandardMaterial("Source", scene);
    captures.acquireTexture("texture");
    const draw = createStartingStateDraw(scene, () => !captures.preparing(), { draws: true, drawAgain: () => captures.rehearsalPending() });
    captures.rehearseManualCaptures(() => !draw.done);
    let views = 0;
    const frame = () => draw.frame(() => {
      views++;
      captures.render();
      return true;
    });
    return { ...setup, draw, frame, views: () => views };
  }

  it("tries it again in the next frame, which draws the view again, until it has drawn", () => {
    const { draws, draw, frame, views, captures } = startingState();
    // Its override Material's variant is still compiling for the first try.
    vi.mocked(RenderTargetTexture.prototype.isReadyForRendering).mockReturnValueOnce(false);
    frame();
    expect([views(), draws.length, captures.rehearsalPending(), draw.done]).toEqual([1, 0, true, false]);
    frame();
    expect([views(), draws.length, captures.rehearsalPending()]).toEqual([2, 1, false]);
  });

  it("ends within a frame of the rehearsal drawing, and waits no longer for one", () => {
    const { draws, draw, frame, views } = startingState();
    const ready = vi.mocked(RenderTargetTexture.prototype.isReadyForRendering);
    // Three tries find its variants compiling; the fourth draws.
    ready.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false);
    for (let index = 0; index < 4; index++) frame();
    expect([views(), draws.length, draw.done]).toEqual([4, 1, false]);
    // Nothing undrawn and nothing waiting: the next frame ends it without drawing.
    frame();
    expect([views(), draw.done]).toEqual([4, true]);
  });
});

it("rehearses a manual capture not yet requested in Play's starting state, unpublished, keeping its request state", () => {
  const { scene, captures, draws, engine } = host();
  engine.getCaps().textureHalfFloatRender = true;
  vi.spyOn(normalMaterial, "createRenderTargetDepthMaterial").mockImplementation((scene) => new NodeMaterial("Capture Depth Variant", scene));
  captures.setAssets(new Map([["target", { mode: "DepthPass", width: 16, height: 8 }]]), new Map([["texture", { renderTargetGuid: "target" }]]));
  const mesh = MeshBuilder.CreateBox("Model", {}, scene); mesh.material = new StandardMaterial("Source", scene);
  captures.acquireTexture("texture");
  // A gameplay frame leaves the manual capture alone.
  captures.render();
  expect(draws).toHaveLength(0);
  // Play's starting state draws it once, with its override Material, unpublished; until it draws it is pending.
  let starting = true;
  captures.rehearseManualCaptures(() => starting);
  const ready = vi.mocked(RenderTargetTexture.prototype.isReadyForRendering);
  ready.mockReturnValueOnce(false);
  captures.render();
  expect([draws.length, captures.rehearsalPending()]).toEqual([0, true]);
  captures.render();
  expect([draws.length, captures.rehearsalPending()]).toEqual([1, false]);
  captures.render();
  expect(draws).toHaveLength(1);
  starting = false;
  const target = scene.textures.find((entry) => entry.name === "renderTarget:target") as RenderTargetTexture;
  expect(mesh.getMaterialForRenderPass(target.renderPassId)?.name).toBe("Capture Depth Variant");
  expect(captures.diagnostics()[0]).toMatchObject({ published: false });
  // Nothing was requested, so gameplay still waits for a request, which then captures and publishes.
  captures.render();
  expect(draws).toHaveLength(1);
  captures.request("capture"); captures.render();
  expect(draws).toHaveLength(2);
  expect(captures.diagnostics()[0]).toMatchObject({ published: true });
  // A published output keeps its last capture: a later load's starting state does not draw over it.
  captures.rehearseManualCaptures(() => true);
  captures.render();
  expect(draws).toHaveLength(2);
});

describe("an every-frame capture draws only while something shows its output", () => {
  /** An every-frame capture and a screen, in front of the view's camera, whose Material samples its output. */
  function shown() {
    const made = host();
    const { scene, engine, captures, root, settings } = made;
    captures.configure("capture", { ...settings, captureEveryFrame: true }, () => root);
    const screen = MeshBuilder.CreatePlane("screen", { size: 1 }, scene);
    const material = new StandardMaterial("screen", scene);
    material.emissiveTexture = captures.acquireTexture("texture")!.resource;
    screen.material = material;
    const frame = () => {
      (engine as unknown as { _frameId: number })._frameId += 1;
      const before = made.draws.length;
      captures.render();
      return made.draws.length - before;
    };
    const place = (z: number) => { screen.position.z = z; screen.computeWorldMatrix(true); };
    return { ...made, screen, material, frame, place };
  }

  it("keeps its last image while the screen is outside the view, and draws again in the frame it comes back", () => {
    const { screen, frame, place } = shown();
    // Its first image, then one a frame while the view shows the screen.
    expect([frame(), frame(), frame()]).toEqual([1, 1, 1]);
    // Behind the camera: nothing shows the output.
    place(-50);
    expect([frame(), frame()]).toEqual([0, 0]);
    place(0);
    expect(frame()).toBe(1);
    // Hidden or disabled, the screen shows nothing either.
    screen.isVisible = false;
    expect(frame()).toBe(0);
    screen.isVisible = true;
    screen.setEnabled(false);
    expect(frame()).toBe(0);
    screen.setEnabled(true);
    expect(frame()).toBe(1);
    // A mesh that draws nothing itself shows nothing, wherever it is: an actor's geometry-less root with the Material.
    place(-50);
    const root = new Mesh("root", screen.getScene());
    root.material = screen.material;
    expect(frame()).toBe(0);
  });

  it("keeps drawing while a consumer cannot be placed", () => {
    const { scene, captures, screen, material, frame, place } = shown();
    frame();
    place(-50);
    expect(frame()).toBe(0);
    // A Material no mesh draws with samples it: a post-process's or a particle system's.
    const unplaced = new StandardMaterial("unplaced", scene);
    unplaced.emissiveTexture = material.emissiveTexture;
    expect(frame()).toBe(1);
    unplaced.dispose();
    expect(frame()).toBe(0);
    // No mesh's Material samples it at all: whoever shows it is not known here.
    screen.material = null;
    material.dispose();
    expect(frame()).toBe(1);
    // Another Scene holds its texture (a Scene Layer's image).
    const again = new StandardMaterial("again", scene);
    again.emissiveTexture = captures.acquireTexture("texture")!.resource;
    screen.material = again;
    expect(frame()).toBe(0);
    captures.acquireTexture("texture", new Scene(scene.getEngine()));
    expect(frame()).toBe(1);
  });

  it("draws in the frame after a reflection or another capture's pass lists the screen, not for its own pass", () => {
    const { scene, camera, frame, place, screen } = shown();
    // The view looks away; the capture itself faces the screen and lists it in its own pass.
    camera.setTarget(new Vector3(0, 0, -10));
    place(3);
    expect([frame(), frame(), frame()]).toEqual([1, 0, 0]);
    // A reflection that draws the screen shows the output: the capture draws in the next frame.
    notePassListed(scene, [screen]);
    expect([frame(), frame()]).toEqual([1, 0]);
    // So does another capture's pass.
    notePassListed(scene, [screen], "other");
    expect(frame()).toBe(1);
  });

  it("still draws a manual capture when asked, whatever shows it", () => {
    const { captures, root, settings, frame, place } = shown();
    frame();
    place(-50);
    captures.configure("capture", { ...settings, captureEveryFrame: false }, () => root);
    captures.request("capture");
    expect([frame(), frame()]).toEqual([1, 0]);
  });
});
