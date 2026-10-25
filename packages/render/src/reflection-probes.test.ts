import { afterEach, expect, it, vi } from "vitest";
import {
  CubeTexture,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  PBRMaterial,
  Quaternion,
  Scene,
  SphericalPolynomial,
  TransformNode,
  Vector3,
  type Mesh,
  type RenderTargetWrapper,
} from "@babylonjs/core";
import { REFLECTION_PROBE_CLASS_ID, reflectionProbeBindings } from "@haptic/core";
import { environmentPolynomial } from "./environment-irradiance";
import { createFilteredEnvironmentTarget, filterEnvironment } from "./environment-prefilter";
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
