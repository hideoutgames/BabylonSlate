import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Meshes/instancedMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, expect, it } from "vitest";
import { isRenderTargetProbeReady, outsideReadinessProbeScope, readinessProbeListScope, withReadinessProbeScope } from "./readiness-scope";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  const [first, second] = [MeshBuilder.CreateBox("first", {}, scene), MeshBuilder.CreateBox("second", {}, scene)];
  const target = (name: string) => {
    const texture = new RenderTargetTexture(name, 8, scene);
    texture.renderList = [first, second];
    const asked: AbstractMesh[] = [];
    texture.customIsReadyFunction = (mesh) => { asked.push(mesh); return true; };
    return { texture, asked };
  };
  return { first, second, target };
}

it("leaves a mesh out only inside a scoped probe that does not name it", () => {
  const { first, second } = fixture();
  expect(outsideReadinessProbeScope(first)).toBe(false);
  withReadinessProbeScope(new Set([first]), () => {
    expect(outsideReadinessProbeScope(first)).toBe(false);
    expect(outsideReadinessProbeScope(second)).toBe(true);
  });
  expect(outsideReadinessProbeScope(second)).toBe(false);
  // A source's batch is probed through its instances: they are asked when it is, and it is not when only one is.
  const instance = second.createInstance("instance");
  withReadinessProbeScope(new Set([second]), () => expect(outsideReadinessProbeScope(instance)).toBe(false));
  withReadinessProbeScope(new Set([instance]), () => expect(outsideReadinessProbeScope(second)).toBe(true));
});

it("asks a render target for the scope's meshes only once a whole probe found it ready", () => {
  const { first, second, target } = fixture();
  const probed = target("probed");
  const check = probed.texture.customIsReadyFunction;
  // A target no whole probe has found ready asks every mesh, also inside a scoped probe (a mirror made since).
  expect(withReadinessProbeScope(new Set([second]), () => isRenderTargetProbeReady(probed.texture))).toBe(true);
  expect(probed.asked).toEqual([first, second]);
  probed.asked.length = 0;
  expect(withReadinessProbeScope(new Set([second]), () => isRenderTargetProbeReady(probed.texture))).toBe(true);
  expect(probed.asked).toEqual([second]);
  // Its own check is back in place for its draws, and a whole probe asks every mesh again.
  expect(probed.texture.customIsReadyFunction).toBe(check);
  probed.asked.length = 0;
  expect(isRenderTargetProbeReady(probed.texture)).toBe(true);
  expect(probed.asked).toEqual([first, second]);
});

it("tells a render target's list which meshes a scoped probe asks, once a whole probe found the target ready", () => {
  const { first, second, target } = fixture();
  const listed = target("listed");
  const scopes: Array<ReadonlySet<AbstractMesh> | undefined> = [];
  listed.texture.getCustomRenderList = () => { scopes.push(readinessProbeListScope()); return [first, second]; };
  const scope = new Set([second]);
  // A target no whole probe has found ready lists every mesh, also inside a scoped probe; so does a whole probe.
  expect(withReadinessProbeScope(scope, () => isRenderTargetProbeReady(listed.texture))).toBe(true);
  expect(isRenderTargetProbeReady(listed.texture)).toBe(true);
  expect(scopes).toEqual([undefined, undefined]);
  expect(withReadinessProbeScope(scope, () => isRenderTargetProbeReady(listed.texture))).toBe(true);
  expect(scopes[2]).toBe(scope);
  // Outside the target's probe nothing is scoped: a real pass lists every mesh.
  expect(readinessProbeListScope()).toBeUndefined();
  withReadinessProbeScope(scope, () => expect(readinessProbeListScope()).toBeUndefined());
});

it("keeps asking every mesh of a render target that a whole probe found unready", () => {
  const { first, second, target } = fixture();
  const unready = target("unready");
  unready.texture.customIsReadyFunction = (mesh) => { unready.asked.push(mesh); return mesh !== first; };
  expect(isRenderTargetProbeReady(unready.texture)).toBe(false);
  unready.asked.length = 0;
  expect(withReadinessProbeScope(new Set([second]), () => isRenderTargetProbeReady(unready.texture))).toBe(false);
  expect(unready.asked).toContain(first);
});
