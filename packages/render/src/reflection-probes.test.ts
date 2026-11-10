import { afterEach, expect, it, vi } from "vitest";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine, NullEngineOptions } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { REFLECTION_PROBE_CLASS_ID, createActor, createDefaultScene, reflectionProbeBindings } from "@haptic/core";
import { availableManagedRenderBytes, beginManagedRenderAllocation, managedRenderReservations } from "./managed-render-resources";
import { environmentPolynomial } from "./environment-irradiance";
import { createFilteredEnvironmentTarget, filterEnvironment } from "./environment-prefilter";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { DisplayConversion } from "./display-conversion";
import { REFLECTION_PROBE_RECAPTURE_DELAY_MS, sceneReflectionProbes } from "./reflection-probes";
import { drawOutsideSceneView } from "./render-target-capture";

// Capturing and filtering need a GPU; what the controller does with a published cube is what this covers.
vi.mock("./environment-prefilter", async (importOriginal) => ({
  ...await importOriginal<typeof import("./environment-prefilter")>(),
  createFilteredEnvironmentTarget: vi.fn(),
  filterEnvironment: vi.fn(),
}));
vi.mock("./environment-irradiance", async (importOriginal) => ({
  ...await importOriginal<typeof import("./environment-irradiance")>(),
  environmentPolynomial: vi.fn(),
}));
vi.mock("./render-target-capture", async (importOriginal) => ({
  ...await importOriginal<typeof import("./render-target-capture")>(),
  drawOutsideSceneView: vi.fn(),
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function fixture() {
  const options = new NullEngineOptions();
  // Babylon's headless WebGL2 option keeps real CPU-side uniform buffers, which frozen materials bind from.
  options.enableMultiview = true;
  const engine = new NullEngine(options);
  // The installed NullEngine builds a cube target's texture but never attaches it.
  const createCube = engine.createRenderTargetCubeTexture.bind(engine);
  engine.createRenderTargetCubeTexture = (...args) => {
    const target = createCube(...args);
    target.setTexture(engine.getLoadedTexturesCache().at(-1)!);
    return target;
  };
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const cube = (name: string) => {
    const internal = engine.createTexture(name, false, false, null);
    internal.isCube = true;
    internal._sphericalPolynomial = new SphericalPolynomial();
    const texture = new CubeTexture("", engine);
    texture._texture = internal;
    return texture;
  };
  vi.mocked(createFilteredEnvironmentTarget).mockImplementation(() => {
    const filtered = cube("filtered");
    const target = { texture: filtered.getInternalTexture() } as unknown as RenderTargetWrapper;
    return { cube: filtered, target, size: 64, release: () => filtered.dispose() };
  });
  vi.mocked(filterEnvironment).mockResolvedValue(undefined);
  vi.mocked(environmentPolynomial).mockImplementation(async () => new SphericalPolynomial());
  vi.mocked(drawOutsideSceneView).mockReturnValue(true);
  const material = new PBRMaterial("surface", scene);
  const inside = MeshBuilder.CreateBox("inside", {}, scene);
  inside.material = material;
  const root = new TransformNode("probe actor", scene);
  const probes = sceneReflectionProbes(scene);
  probes.setStaticPredicate(() => true);
  const bindings = (size: [number, number, number]) => reflectionProbeBindings([
    { id: "probe", classId: REFLECTION_PROBE_CLASS_ID, properties: { size, resolution: 64 } },
  ]);
  /** Let edits settle, then run one scene frame's probe update. */
  const frame = () => {
    now += REFLECTION_PROBE_RECAPTURE_DELAY_MS;
    scene.onBeforeRenderObservable.notifyObservers(scene);
  };
  const publish = async (size: [number, number, number]) => {
    probes.upsert("actor", root, bindings(size));
    frame();
    await vi.waitFor(() => expect(probes.diagnostics()[0]?.published).toBe(true));
  };
  return { scene, cube, material, inside, root, probes, frame, publish };
}

async function readyDefines(scene: Scene, material: PBRMaterial, mesh: Mesh): Promise<Record<string, unknown>> {
  // A new render id makes the material re-check the submesh instead of reusing this frame's answer.
  scene.incrementRenderId();
  const subMesh = mesh.subMeshes[0]!;
  await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
  return subMesh.materialDefines as unknown as Record<string, unknown>;
}

/** Draw `mesh` in a new frame and return the projection box size its material's uniform buffer then holds. */
function boundReflectionSize(scene: Scene, material: PBRMaterial, mesh: Mesh): number[] {
  scene.activeCamera ??= new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  scene.updateTransformMatrix(true);
  scene.resetCachedMaterial();
  material.bindForSubMesh(mesh.getWorldMatrix(), mesh, mesh.subMeshes[0]!);
  const ubo = material._uniformBuffer;
  const offset = (ubo as unknown as { _uniformLocations: Record<string, number> })._uniformLocations.vReflectionSize!;
  return [...ubo.getData().subarray(offset, offset + 3)];
}

it("projects reflections onto the probe's new box when its actor turns, even at the same volume and centre", async () => {
  const { scene, material, inside, root, frame, publish } = fixture();
  // The editor freezes its default material, which then rebinds its uniform buffer only when forced to.
  material.freeze();
  root.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.PI / 6, 0, 0);
  await publish([8, 2, 4]);
  await readyDefines(scene, material, inside);
  const before = boundReflectionSize(scene, material, inside);
  [8.928, 2, 7.464].forEach((extent, axis) => expect(before[axis]).toBeCloseTo(extent, 3));
  // Turning from 30 to 60 degrees swaps the world box's x and z extents.
  root.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.PI / 3, 0, 0);
  frame();
  await readyDefines(scene, material, inside);
  const after = boundReflectionSize(scene, material, inside);
  [7.464, 2, 8.928].forEach((extent, axis) => expect(after[axis]).toBeCloseTo(extent, 3));
});

it("recompiles meshes for a probe's cube when the first probe publishes and for the scene's when the last goes", async () => {
  const { scene, cube, material, inside, probes, publish } = fixture();
  // The scene's own cube has no box, so only a probe's cube compiles box projection.
  scene.environmentTexture = cube("sky");
  expect((await readyDefines(scene, material, inside)).USE_LOCAL_REFLECTIONMAP_CUBIC).toBe(false);
  await publish([8, 4, 8]);
  expect((await readyDefines(scene, material, inside)).USE_LOCAL_REFLECTIONMAP_CUBIC).toBe(true);
  probes.remove("actor");
  expect((await readyDefines(scene, material, inside)).USE_LOCAL_REFLECTIONMAP_CUBIC).toBe(false);
});

/**
 * A capture's bytes at resolution 64: the raw cube's half-float colour with every mip of six faces, and the scene
 * colour target one face is drawn in, with its depth.
 */
const CAPTURE_BYTES_64 = 6 * 8 * (64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1) + 64 * 64 * (8 + 4);
const captureCube = (scene: Scene) => scene.textures.find((texture) => texture.name === "reflectionProbe:actor:probe");
const captureFace = (scene: Scene) => scene.textures.find((texture) => texture.name === "reflectionProbe:actor:probe:face");

it("frees a runtime probe's raw capture cube once its filtered cube publishes, and captures into a new one when the static scene changes", async () => {
  const { scene, probes, publish, frame } = fixture();
  const environment = () => managedRenderReservations(scene.getEngine()).categoryBytes.environment;
  await publish([8, 4, 8]);
  // Lighting reads the filtered cube alone: the raw half-float cube and its depth go with their lease.
  await vi.waitFor(() => expect(environment()).toBe(0));
  expect(captureCube(scene)).toBeUndefined();
  expect(captureFace(scene)).toBeUndefined();
  const draws = vi.mocked(drawOutsideSceneView).mock.calls.length;
  // Its filtering takes a while: the new cube is held until it finishes.
  let filtered!: () => void;
  vi.mocked(filterEnvironment).mockImplementationOnce(() => new Promise<void>((resolve) => { filtered = resolve; }));
  MeshBuilder.CreateBox("added", {}, scene);
  frame();
  expect(vi.mocked(drawOutsideSceneView).mock.calls.length).toBe(draws + 1);
  expect(environment()).toBe(CAPTURE_BYTES_64);
  expect(captureCube(scene)).toBeDefined();
  expect(captureFace(scene)).toBeDefined();
  filtered();
  await vi.waitFor(() => expect(environment()).toBe(0));
  expect(captureCube(scene)).toBeUndefined();
  expect(probes.diagnostics()[0]?.published).toBe(true);
});

/** Runs the capture's draw with the GPU work recorded in order instead of done. */
function recordedCapture(scene: Scene, conversionReady: boolean) {
  const engine = scene.getEngine();
  const order: string[] = [];
  const views: string[] = [];
  vi.mocked(drawOutsideSceneView).mockImplementation((_scene, run) => run());
  // As Babylon's own check: it announces a draw of the target, with nothing drawn, to ask its meshes.
  vi.spyOn(RenderTargetTexture.prototype, "isReadyForRendering").mockImplementation(function (this: RenderTargetTexture) {
    this.onBeforeRenderObservable.notifyObservers(0);
    this.onAfterUnbindObservable.notifyObservers(this);
    return true;
  });
  vi.spyOn(RenderTargetTexture.prototype, "render").mockImplementation(function (this: RenderTargetTexture) {
    this.onBeforeRenderObservable.notifyObservers(0);
    views.push(scene.getViewMatrix().asArray().map((value) => Math.round(value)).join(","));
    order.push(`draw ${this.name}`);
  });
  vi.spyOn(engine, "bindFramebuffer").mockImplementation((target, face) => { order.push(`bind ${target.label ?? "cube"} face ${face}`); });
  vi.spyOn(engine, "unBindFramebuffer").mockImplementation(() => {});
  vi.spyOn(engine, "setDepthWrite").mockImplementation((enabled) => { if (order.at(-1) !== `depth writes: ${enabled}`) order.push(`depth writes: ${enabled}`); });
  vi.spyOn(engine, "generateMipMapsForCubemap").mockImplementation((texture) => { order.push(`mips ${texture.isCube ? "cube" : "other"}`); });
  vi.spyOn(DisplayConversion.prototype, "ready").mockImplementation((linear) => { order.push(`conversion from linear: ${linear}`); return conversionReady; });
  vi.spyOn(DisplayConversion.prototype, "draw").mockImplementation((source) => { order.push(`convert ${source.name}`); });
  return { order, views };
}

it("draws each face with the view's programs, then stores it display-referred in the cube's face", async () => {
  const { scene, publish } = fixture();
  scene.imageProcessingConfiguration.applyByPostProcess = true;
  const { order, views } = recordedCapture(scene, true);
  await publish([8, 4, 8]);
  const face = "reflectionProbe:actor:probe:face";
  expect(order).toEqual([
    "conversion from linear: true",
    // A face's clear writes depth only where depth writes are on, whatever the pass before left.
    ...[0, 1, 2, 3, 4, 5].flatMap((index) => ["depth writes: true", `draw ${face}`, `bind cube face ${index}`, `convert ${face}`]),
    "mips cube",
    // The caller's own state, restored.
    "depth writes: true",
  ]);
  // Each draw looks along its own face's axis.
  expect(new Set(views).size).toBe(6);
  // The Scene keeps its own setting: nothing compiled for the capture alone.
  expect(scene.imageProcessingConfiguration.applyByPostProcess).toBe(true);
  const released = vi.spyOn(DisplayConversion.prototype, "dispose");
  scene.dispose();
  expect(released).toHaveBeenCalledTimes(1);
});

it("captures again after a capture: the readiness check before the six draws announces a draw too", async () => {
  const { scene, publish, frame } = fixture();
  const { order } = recordedCapture(scene, true);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  await publish([8, 4, 8]);
  order.length = 0;
  MeshBuilder.CreateBox("added", {}, scene);
  frame();
  expect(warned).not.toHaveBeenCalled();
  expect(order.filter((entry) => entry.startsWith("convert"))).toHaveLength(6);
});

it("copies faces a view that is not Scene Linear already drew for display, and waits for the pass to compile", async () => {
  const { scene, probes, root, frame } = fixture();
  const { order } = recordedCapture(scene, false);
  const filters = vi.mocked(filterEnvironment).mock.calls.length;
  probes.upsert("actor", root, reflectionProbeBindings([{ id: "probe", classId: REFLECTION_PROBE_CLASS_ID, properties: { size: [8, 4, 8], resolution: 64 } }]));
  frame();
  // Not compiled yet: nothing is drawn and nothing filtered; the probe tries again.
  expect(order.filter((entry) => !entry.startsWith("depth writes"))).toEqual(["conversion from linear: false"]);
  expect(vi.mocked(filterEnvironment).mock.calls.length).toBe(filters);
  expect(probes.diagnostics()[0]?.published).toBe(false);
  vi.mocked(DisplayConversion.prototype.ready).mockReturnValue(true);
  frame();
  await vi.waitFor(() => expect(probes.diagnostics()[0]?.published).toBe(true));
  expect(order.filter((entry) => entry.startsWith("convert"))).toHaveLength(6);
});

it("keeps a runtime probe published when the budget refuses its new capture cube, and recaptures once the budget has room", async () => {
  const { scene, probes, publish, frame } = fixture();
  const engine = scene.getEngine();
  await publish([8, 4, 8]);
  // Its first capture cube is already freed, so the filler leaves no room for a new one.
  await vi.waitFor(() => expect(managedRenderReservations(engine).categoryBytes.environment).toBe(0));
  const filler = beginManagedRenderAllocation(engine, availableManagedRenderBytes(engine))!;
  const draws = vi.mocked(drawOutsideSceneView).mock.calls.length;
  MeshBuilder.CreateBox("added", {}, scene);
  frame();
  expect(vi.mocked(drawOutsideSceneView).mock.calls.length).toBe(draws);
  expect(probes.diagnostics()[0]?.published).toBe(true);
  // No forced recapture and no further static change: the refused capture retries on its own.
  filler.release();
  frame();
  expect(vi.mocked(drawOutsideSceneView).mock.calls.length).toBe(draws + 1);
  expect(captureCube(scene)).toBeDefined();
});

it("keeps an editor probe's capture cube, which every settled document edit draws again", async () => {
  const { scene, inside, probes, frame } = fixture();
  inside.parent = new Mesh("editorActor:actor", scene);
  const document = createDefaultScene();
  document.actors.push(createActor("actor", "Probe", {
    components: [{ id: "probe", classId: REFLECTION_PROBE_CLASS_ID, properties: { size: [8, 4, 8], resolution: 64 } }],
  }));
  probes.syncAuthored(document);
  frame();
  await vi.waitFor(() => expect(probes.diagnostics()[0]?.published).toBe(true));
  // Past the capture's settling, where a runtime probe frees its cube.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(managedRenderReservations(scene.getEngine()).categoryBytes.environment).toBe(CAPTURE_BYTES_64);
  expect(captureCube(scene)).toBeDefined();
});
