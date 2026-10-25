import { afterEach, expect, it, vi } from "vitest";
import {
  CubeTexture,
  Effect,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Quaternion,
  Scene,
  SphericalPolynomial,
  TransformNode,
  Vector3,
  type BaseTexture,
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
  const engine = new NullEngine();
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

/** The environment cube `mesh`'s draw binds. */
function boundEnvironment(scene: Scene, material: PBRMaterial, mesh: Mesh): BaseTexture | undefined {
  scene.activeCamera ??= new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  scene.updateTransformMatrix(true);
  let bound: BaseTexture | undefined;
  const setTexture = Effect.prototype.setTexture;
  const spy = vi.spyOn(Effect.prototype, "setTexture").mockImplementation(function (this: Effect, channel, texture) {
    if (channel === "reflectionSampler" && texture) bound = texture as BaseTexture;
    return setTexture.call(this, channel, texture);
  });
  material.bindForSubMesh(mesh.getWorldMatrix(), mesh, mesh.subMeshes[0]!);
  spy.mockRestore();
  return bound;
}

it("projects reflections onto the probe's new box when its actor turns, even at the same volume and centre", async () => {
  const { scene, material, inside, root, frame, publish } = fixture();
  root.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.PI / 6, 0, 0);
  await publish([8, 2, 4]);
  await readyDefines(scene, material, inside);
  // Turning from 30 to 60 degrees swaps the world box's x and z extents.
  root.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.PI / 3, 0, 0);
  frame();
  await readyDefines(scene, material, inside);
  const box = (boundEnvironment(scene, material, inside) as CubeTexture).boundingBoxSize;
  expect(box.x).toBeCloseTo(7.464, 3);
  expect(box.y).toBeCloseTo(2, 3);
  expect(box.z).toBeCloseTo(8.928, 3);
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
