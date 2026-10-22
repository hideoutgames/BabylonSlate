import { afterEach, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene, ShadowGenerator, SpotLight, StandardMaterial, Vector3, type AbstractMesh } from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { ensureNativeLatticeShadowDepthWrapper, releaseNativeLatticeShadowDepthWrapper } from "./native-lattice-shadow";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** Authored WPO casters. Materials compiled from one graph under one name share their depth Effect. */
async function wpoScene() {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const document = createDefaultMaterialDocument();
  document.nodes.find((node) => node.type === "output.surface")!.properties["default:worldPositionOffset"] = [0, 1, 0];
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const casters: AbstractMesh[] = [];
  return {
    async caster() {
      const compiled = compileMaterialPlan(lowered.plan, { scene, name: "material:wpo" });
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      expect(await compiled.ready).toEqual([]);
      const mesh = MeshBuilder.CreateBox(`caster-${casters.length}`, {}, scene);
      mesh.material = compiled.material;
      casters.push(mesh);
      return mesh;
    },
    /** A new generator on its own light, compiled for every caster so far. */
    async generator() {
      const generator = new ShadowGenerator(256, new SpotLight("spot", new Vector3(0, 6, 0), Vector3.Down(), 1, 1, scene));
      for (const mesh of casters) generator.addShadowCaster(mesh);
      await generator.forceCompilationAsync();
      return generator;
    },
    /** The caster's depth draw wrapper for a generator, null once that entry is retired. */
    entry: (mesh: AbstractMesh, generator: ShadowGenerator) =>
      mesh.material!.shadowDepthWrapper!.getEffect(mesh.subMeshes[0]!, generator, engine.currentRenderPassId),
  };
}

it("keeps a shared depth Effect for the generators still using it and releases it with the last", async () => {
  const { caster, generator, entry } = await wpoScene();
  const mesh = await caster();
  const first = await generator();
  const second = await generator();
  const shared = entry(mesh, first)!.effect!;
  expect(shared).toBeTruthy();
  expect(entry(mesh, second)!.effect).toBe(shared);
  first.dispose();
  expect(entry(mesh, first)).toBeNull();
  expect(shared.isDisposed).toBe(false);
  expect(entry(mesh, second)!.effect).toBe(shared);
  // A re-created generator takes its own reference to the surviving Effect.
  const third = await generator();
  expect(entry(mesh, third)!.effect).toBe(shared);
  second.dispose();
  expect(shared.isDisposed).toBe(false);
  third.dispose();
  expect(shared.isDisposed).toBe(true);
  // The caster and its material outlive every generator and still shadow a new one.
  const fresh = entry(mesh, await generator())!.effect!;
  expect(fresh).not.toBe(shared);
  expect(fresh.isDisposed).toBe(false);
});

it("releases a generator's reference once however often it is disposed, and a late probe takes none", async () => {
  const { caster, generator, entry } = await wpoScene();
  const mesh = await caster();
  const first = await generator();
  const second = await generator();
  const shared = entry(mesh, first)!.effect!;
  // The controller disposes a light's generator after Babylon's own Light.dispose did.
  first.getLight().dispose();
  first.dispose();
  first.dispose();
  expect(entry(mesh, first)).toBeNull();
  expect(shared.isDisposed).toBe(false);
  // A late readiness probe of the disposed generator takes no reference.
  expect(mesh.material!.shadowDepthWrapper!.isReadyForSubMesh(mesh.subMeshes[0]!, [], first, false, 0)).toBe(false);
  expect(entry(mesh, first)).toBeNull();
  second.getLight().dispose();
  expect(shared.isDisposed).toBe(true);
});

it("releases only the replaced reference at a define change and only the current one at disposal", async () => {
  const { caster, generator, entry } = await wpoScene();
  const mesh = await caster();
  const first = await generator();
  const second = await generator();
  const shared = entry(mesh, first)!.effect!;
  first.normalBias = 0.05;
  await first.forceCompilationAsync();
  const replacement = entry(mesh, first)!.effect!;
  expect(replacement).not.toBe(shared);
  expect(shared.isDisposed).toBe(false);
  first.dispose();
  expect(replacement.isDisposed).toBe(true);
  expect(shared.isDisposed).toBe(false);
  expect(entry(mesh, second)!.effect).toBe(shared);
  second.dispose();
  expect(shared.isDisposed).toBe(true);
});

it("leaves another wrapper's references alone when a generator is disposed after a wrapper", async () => {
  const { caster, generator, entry } = await wpoScene();
  const disposed = await caster();
  const live = await caster();
  const first = await generator();
  const second = await generator();
  const shared = entry(live, first)!.effect!;
  expect(entry(disposed, first)!.effect).toBe(shared);
  disposed.material!.shadowDepthWrapper!.dispose();
  expect(shared.isDisposed).toBe(false);
  expect(() => first.dispose()).not.toThrow();
  // The live caster's entry for the other generator still holds the Effect.
  expect(shared.isDisposed).toBe(false);
  expect(entry(live, second)!.effect).toBe(shared);
  second.dispose();
  expect(shared.isDisposed).toBe(true);
});

it("retires the entries the native lattice facade holds through its authored generation", async () => {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const source = new StandardMaterial("lattice-source", scene);
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  mesh.material = source;
  expect(ensureNativeLatticeShadowDepthWrapper(source)).toBe(true);
  const generator = new ShadowGenerator(256, new SpotLight("spot", new Vector3(0, 6, 0), Vector3.Down(), 1, 1, scene));
  generator.addShadowCaster(mesh);
  await generator.forceCompilationAsync();
  const depth = source.shadowDepthWrapper!.getEffect(mesh.subMeshes[0]!, generator, engine.currentRenderPassId)?.effect;
  expect(depth).toBeTruthy();
  generator.dispose();
  expect(depth!.isDisposed).toBe(true);
  await releaseNativeLatticeShadowDepthWrapper(source);
});
