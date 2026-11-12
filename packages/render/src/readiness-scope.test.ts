import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Meshes/instancedMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, expect, it } from "vitest";
import { isRenderTargetProbeReady, outsideReadinessProbeScope, withReadinessProbeScope } from "./readiness-scope";

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

it("builds no list of a render target for a scope without meshes, and still checks what else the target draws", () => {
  const { first, second, target } = fixture();
  const listed = target("listed");
  let lists = 0;
  const list = listed.texture.getCustomRenderList = () => { lists += 1; return [first, second]; };
  // A target no whole probe has found ready builds its list, also for a scope without meshes.
  expect(withReadinessProbeScope(new Set(), () => isRenderTargetProbeReady(listed.texture))).toBe(true);
  expect(lists).toBe(1);
  expect(listed.asked).toEqual([first, second]);
  listed.asked.length = 0;
  expect(withReadinessProbeScope(new Set(), () => isRenderTargetProbeReady(listed.texture))).toBe(true);
  expect(lists).toBe(1);
  expect(listed.asked).toEqual([]);
  // Its own list is back in place for its draws; a scope that names a mesh builds it, as a whole probe does.
  expect(listed.texture.getCustomRenderList).toBe(list);
  expect(withReadinessProbeScope(new Set([second]), () => isRenderTargetProbeReady(listed.texture))).toBe(true);
  expect(lists).toBe(2);
  expect(listed.asked).toEqual([second]);
  expect(isRenderTargetProbeReady(listed.texture)).toBe(true);
  expect(lists).toBe(3);
  // The particle systems a target draws are asked whatever the scope.
  listed.texture.renderParticles = true;
  const particles = { isReady: () => false };
  listed.texture.particleSystemList = [particles as never];
  expect(withReadinessProbeScope(new Set(), () => isRenderTargetProbeReady(listed.texture))).toBe(false);
  expect(lists).toBe(3);
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
