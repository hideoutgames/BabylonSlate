import { afterEach, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene, ShadowGenerator, SpotLight, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { ensureNativeLatticeShadowDepthWrapper, releaseNativeLatticeShadowDepthWrapper } from "./native-lattice-shadow";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** One authored WPO caster, whose generators each compile its shared depth Effect. */
async function wpoCaster() {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const document = createDefaultMaterialDocument();
  document.nodes.find((node) => node.type === "output.surface")!.properties["default:worldPositionOffset"] = [0, 1, 0];
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "material:wpo" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  mesh.material = compiled.material;
  const wrapper = compiled.material.shadowDepthWrapper!;
  return {
    compiled, mesh,
    async generator() {
      const light = new SpotLight("spot", new Vector3(0, 6, 0), Vector3.Down(), 1, 1, scene);
      const generator = new ShadowGenerator(256, light);
      generator.addShadowCaster(mesh);
      await generator.forceCompilationAsync();
      return generator;
    },
    entry: (generator: ShadowGenerator) => wrapper.getEffect(mesh.subMeshes[0]!, generator, engine.currentRenderPassId),
  };
}

it("retires a disposed generator's depth entries and releases the shared Effect with its last user", async () => {
  const { compiled, mesh, generator, entry } = await wpoCaster();
  const first = await generator();
  const second = await generator();
  const shared = entry(first)!.effect!;
  expect(shared).toBeTruthy();
  expect(entry(second)!.effect).toBe(shared);
  first.dispose();
  expect(entry(first)).toBeNull();
  expect(shared.isDisposed).toBe(false);
  expect(entry(second)!.effect).toBe(shared);
  // A re-created generator takes its own reference to the surviving Effect.
  const third = await generator();
  expect(entry(third)!.effect).toBe(shared);
  second.dispose();
  expect(shared.isDisposed).toBe(false);
  third.dispose();
  expect(shared.isDisposed).toBe(true);
  expect(mesh.isDisposed()).toBe(false);
  expect(compiled.material.shadowDepthWrapper).not.toBeNull();
  // The caster and its material outlive every generator and still shadow a new one.
  const fourth = await generator();
  const fresh = entry(fourth)!.effect!;
  expect(fresh).not.toBe(shared);
  expect(fresh.isDisposed).toBe(false);
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

it("releases each generator's reference once, however it is disposed", async () => {
  const { generator, entry } = await wpoCaster();
  const first = await generator();
  const second = await generator();
  const shared = entry(first)!.effect!;
  expect(entry(second)!.effect).toBe(shared);
  // The controller disposes a light's generator after Babylon's own Light.dispose did.
  first.getLight().dispose();
  first.dispose();
  first.dispose();
  expect(entry(first)).toBeNull();
  expect(shared.isDisposed).toBe(false);
  expect(entry(second)!.effect).toBe(shared);
  second.getLight().dispose();
  expect(shared.isDisposed).toBe(true);
});
