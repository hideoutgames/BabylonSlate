import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, ShadowGenerator, SpotLight, StandardMaterial, Vector3 } from "@babylonjs/core";
import { ShadowReceiverWarmup } from "./shadow-receiver-warmup";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
async function fixture() {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  const mesh = MeshBuilder.CreateBox("receiver", {}, scene); mesh.receiveShadows = true;
  const material = new StandardMaterial("receiver", scene); mesh.material = material;
  const light = new SpotLight("incumbent", Vector3.Up(), Vector3.Down(), 1, 1, scene);
  const incoming = new SpotLight("incoming", Vector3.Up(), Vector3.Down(), 1, 1, scene);
  const generator = new ShadowGenerator(256, light); generator.addShadowCaster(mesh);
  engine.currentRenderPassId = camera.renderPassId;
  await material.forceCompilationAsync(mesh);
  const part = mesh.subMeshes[0]!;
  material.isReadyForSubMesh(mesh, part, false); material.freeze();
  const warmer = new ShadowReceiverWarmup(scene);
  const layout = new Map([[light, null], [incoming, generator]]);
  const passes = [camera.renderPassId, engine.createRenderPassId("prepared objects")];
  return { engine, scene, mesh, material, part, light, incoming, generator, warmer, layout, passes };
}

it("warms a future layout without changing live frozen receivers, shadow maps or real submeshes", async () => {
  const { scene, mesh, material, part, light, incoming, generator, warmer, layout, passes } = await fixture();
  const parts = [...mesh.subMeshes], effect = part.effect, textures = [...scene.textures];
  const actual = material.isReadyForSubMesh.bind(material);
  let gpuReady = false;
  const observed: boolean[] = [];
  vi.spyOn(material, "isReadyForSubMesh").mockImplementation((mesh, probe, instances) => {
    observed.push(probe !== part && light.getShadowGenerator() === null && incoming.getShadowGenerator() === generator);
    return actual(mesh, probe, instances) && gpuReady;
  });
  const ready = () => warmer.ready("incoming", layout, passes, () => true);
  expect(ready()).toBe(false);
  warmer.advance();
  expect(ready()).toBe(false);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(Boolean)).toBe(true);
  expect(light.getShadowGenerator()).toBe(generator);
  expect(incoming.getShadowGenerator()).toBeNull();
  expect(material.isFrozen).toBe(true);
  expect(part.effect).toBe(effect);
  expect(mesh.subMeshes).toEqual(parts);
  expect(scene.textures).toEqual(textures);
  gpuReady = true;
  for (let frame = 0; frame < 20 && !ready(); frame++) warmer.advance();
  expect(ready()).toBe(true);
  warmer.commit(); warmer.cancelPending(); warmer.releaseCommitted();
  expect(mesh.subMeshes).toEqual(parts);
  expect(part.effect).toBe(effect);
  expect(effect?.isReady()).toBe(true);
});

it("restores lookups and flags when a probe revokes its pending owner and throws", async () => {
  const { mesh, material, light, incoming, generator, warmer, layout, passes } = await fixture();
  const ownLookup = () => generator;
  Object.defineProperty(light, "getShadowGenerator", { value: ownLookup, configurable: true, writable: false });
  const descriptor = Object.getOwnPropertyDescriptor(light, "getShadowGenerator");
  const parts = [...mesh.subMeshes];
  vi.spyOn(material, "isReadyForSubMesh").mockImplementation(() => {
    warmer.cancel();
    throw new Error("GPU compile revoked");
  });
  expect(warmer.ready("incoming", layout, passes, () => true)).toBe(false);
  warmer.advance();
  expect(Object.getOwnPropertyDescriptor(light, "getShadowGenerator")).toEqual(descriptor);
  expect(Object.hasOwn(incoming, "getShadowGenerator")).toBe(false);
  expect(material.isFrozen).toBe(true);
  expect(mesh.subMeshes).toEqual(parts);
});
