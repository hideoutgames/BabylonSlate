import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, ShadowGenerator, SpotLight, StandardMaterial, Vector3, type Effect } from "@babylonjs/core";
import { ShadowReceiverWarmup } from "./shadow-receiver-warmup";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";

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
  const defines = part.materialDefines?.toString();
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
  expect(part.materialDefines?.toString()).toBe(defines);
  expect(mesh.subMeshes).toEqual(parts);
  expect(scene.textures).toEqual(textures);
  gpuReady = true;
  for (let frame = 0; frame < 20 && !ready(); frame++) warmer.advance();
  expect(ready()).toBe(true);
  warmer.commit(); warmer.cancelPending(); warmer.releaseCommitted();
  expect(mesh.subMeshes).toEqual(parts);
  expect(part.effect).toBe(effect);
  expect(effect?.isReady()).toBe(true);
  expect(part.materialDefines?.toString()).toBe(defines);
});

it("uses normal preparation for wrappers that retain temporary submeshes", async () => {
  const { scene, material, warmer, layout, passes } = await fixture();
  material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene);
  const compile = vi.spyOn(material, "isReadyForSubMesh");
  expect(warmer.ready("incoming", layout, passes, () => true)).toBe(true);
  warmer.advance();
  expect(compile).not.toHaveBeenCalled();
});

it("retains a cancelled last WebGL program until its compiler finishes and bounds further speculation", async () => {
  const { mesh, material, warmer, layout, passes } = await fixture();
  const parts = [...mesh.subMeshes];
  const actual = material.isReadyForSubMesh.bind(material);
  let pending: Effect | undefined;
  vi.spyOn(material, "isReadyForSubMesh").mockImplementation((mesh, probe, instances) => {
    actual(mesh, probe, instances);
    if (!pending && probe.effect) {
      pending = probe.effect;
      const pipeline = pending.getPipelineContext()!;
      // NullEngine has no parallel WebGL compiler. Delay that boundary while
      // retaining native shader generation, references and draw-wrapper disposal.
      vi.spyOn(pending, "getPipelineContext").mockReturnValue(Object.create(pipeline, { isAsync: { value: true }, program: { value: {} } }));
      vi.spyOn(pending, "isReady").mockReturnValue(false);
    }
    return false;
  });
  expect(warmer.ready("incoming", layout, [passes[0]!], () => true)).toBe(false);
  warmer.advance();
  expect(pending).toBeDefined();
  warmer.cancel();
  expect(pending!.isDisposed).toBe(false);
  expect(warmer.ready("next", layout, [passes[0]!], () => true)).toBe(true);
  pending!.onCompileObservable.notifyObservers(pending!);
  expect(pending!.isDisposed).toBe(false);
  await Promise.resolve(); await Promise.resolve();
  expect(pending!.isDisposed).toBe(true);
  expect(mesh.subMeshes).toEqual(parts);
  expect(warmer.ready("next", layout, [passes[0]!], () => true)).toBe(false);
  warmer.cancel();
});

it("restores lookups and flags when a probe revokes its pending owner and throws", async () => {
  const { mesh, material, light, incoming, generator, warmer, layout, passes } = await fixture();
  const ownLookup = () => generator;
  Object.defineProperty(light, "getShadowGenerator", { value: ownLookup, configurable: true, writable: false });
  const descriptor = Object.getOwnPropertyDescriptor(light, "getShadowGenerator");
  const parts = [...mesh.subMeshes];
  let reentrantReady: boolean | undefined;
  vi.spyOn(material, "isReadyForSubMesh").mockImplementation(() => {
    warmer.cancel();
    reentrantReady = warmer.ready("replacement", layout, passes, () => true);
    throw new Error("GPU compile revoked");
  });
  expect(warmer.ready("incoming", layout, passes, () => true)).toBe(false);
  warmer.advance();
  expect(reentrantReady).toBe(true);
  expect(Object.getOwnPropertyDescriptor(light, "getShadowGenerator")).toEqual(descriptor);
  expect(Object.hasOwn(incoming, "getShadowGenerator")).toBe(false);
  expect(material.isFrozen).toBe(true);
  expect(mesh.subMeshes).toEqual(parts);
});
