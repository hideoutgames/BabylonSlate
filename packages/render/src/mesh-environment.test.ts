import { afterEach, expect, it, vi } from "vitest";
import {
  CubeTexture,
  Effect,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  SphericalPolynomial,
  Vector3,
  type BaseTexture,
  type Mesh,
} from "@babylonjs/core";
import { setMeshEnvironmentResolver } from "./mesh-environment";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const cube = (name: string) => {
    const internal = engine.createTexture(name, false, false, null);
    internal.isCube = true;
    internal._sphericalPolynomial = new SphericalPolynomial();
    const texture = new CubeTexture("", scene);
    texture._texture = internal;
    return texture;
  };
  const material = new PBRMaterial("surface", scene);
  const mesh = (name: string): Mesh => {
    const created = MeshBuilder.CreateBox(name, {}, scene);
    created.material = material;
    return created;
  };
  return { scene, cube, material, inside: mesh("inside"), outside: mesh("outside") };
}

async function readyDefines(material: PBRMaterial, mesh: Mesh): Promise<Record<string, unknown>> {
  const subMesh = mesh.subMeshes[0]!;
  await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
  return subMesh.materialDefines as unknown as Record<string, unknown>;
}

it("compiles each mesh for the cube it reflects, so a probe's box projection reaches only its meshes", async () => {
  const { scene, cube, material, inside, outside } = fixture();
  scene.environmentTexture = cube("sky");
  const probe = cube("probe");
  probe.boundingBoxSize = new Vector3(4, 3, 4);
  setMeshEnvironmentResolver(scene, (mesh) => mesh === inside ? probe : null);
  expect((await readyDefines(material, inside)).USE_LOCAL_REFLECTIONMAP_CUBIC).toBe(true);
  expect((await readyDefines(material, outside)).USE_LOCAL_REFLECTIONMAP_CUBIC).toBe(false);
  // The swap never leaks: everything else still sees the scene's own cube.
  expect(scene.environmentTexture?.name).toBe("");
  expect(scene.environmentTexture).not.toBe(probe);
});

it("rebinds a shared material whenever consecutive draws reflect different cubes", async () => {
  const { scene, cube, material, inside, outside } = fixture();
  const sky = cube("sky");
  const probe = cube("probe");
  // Identical defines share one effect, where Babylon would otherwise skip the second bind.
  sky.boundingBoxSize = new Vector3(1e5, 1e5, 1e5);
  probe.boundingBoxSize = new Vector3(4, 3, 4);
  scene.environmentTexture = sky;
  setMeshEnvironmentResolver(scene, (mesh) => mesh === inside ? probe : null);
  await readyDefines(material, inside);
  await readyDefines(material, outside);
  // Bind outside a frame: the scene's uniform buffer needs the camera's matrices.
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  scene.updateTransformMatrix(true);
  expect(inside.subMeshes[0]!.effect).toBe(outside.subMeshes[0]!.effect);
  const bound: BaseTexture[] = [];
  const setTexture = Effect.prototype.setTexture;
  vi.spyOn(Effect.prototype, "setTexture").mockImplementation(function (this: Effect, channel, texture) {
    if (channel === "reflectionSampler" && texture) bound.push(texture as BaseTexture);
    return setTexture.call(this, channel, texture);
  });
  for (const mesh of [inside, outside, outside, inside]) material.bindForSubMesh(mesh.getWorldMatrix(), mesh, mesh.subMeshes[0]!);
  expect(bound.map((texture) => texture === probe ? "probe" : texture === sky ? "sky" : "other")).toEqual(["probe", "sky", "probe"]);
});
