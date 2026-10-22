import { afterEach, describe, expect, it } from "vitest";
import { buildBoxGlbFixture, cookComplexCollisionMesh, normalizeModelPayload } from "@haptic/assets";
import { createActor, createDefaultSceneSettings, type SerializedComponent } from "@haptic/core";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import type { CompiledScript } from "./script-host";

/**
 * Use Simple Collision and Use Complex Collision on a Mesh make an implicit static body on every path that
 * puts an actor in the physics world: a scene actor, a placed Class instance, a Prefab instance and a
 * runtime-spawned Class. No Collision makes none, and so does Use Simple Collision on a Model without
 * simple shapes (the editor warns about that one, see `physics.mesh_collision_empty`).
 */
const SOLID = "solid-model";
const HOLLOW = "hollow-model";
const box = cookComplexCollisionMesh(buildBoxGlbFixture(1))!;
const solidShape = { id: "box-1", name: "Box", kind: "box", position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };

const cases = [
  { name: "simple primitive", properties: { meshKind: "box", collisionMode: "simple" }, solid: true },
  { name: "complex primitive", properties: { meshKind: "sphere", collisionMode: "complex" }, solid: true },
  { name: "simple Model with shapes", properties: { assetGuid: SOLID, collisionMode: "simple" }, solid: true },
  { name: "complex Model", properties: { assetGuid: SOLID, collisionMode: "complex" }, solid: true },
  { name: "no collision primitive", properties: { meshKind: "box", collisionMode: "none" }, solid: false },
  { name: "no collision Model", properties: { assetGuid: SOLID, collisionMode: "none" }, solid: false },
  { name: "simple Model without shapes", properties: { assetGuid: HOLLOW, collisionMode: "simple" }, solid: false },
] as const;

const at = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
const sceneTransform = (x: number) => ({ position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
/** Baked prefab rows keep their source ids and overrides; the runtime reads only their properties. */
const bakedMesh = (properties: Record<string, unknown>): SerializedComponent[] =>
  [{ id: "mesh", classId: "MeshComponent", properties: { ...properties }, sourceId: "prefab-mesh", overrideKeys: ["collisionMode"] }];
const classScript = (classId: string, properties: Record<string, unknown> = {}): CompiledScript => ({
  assetGuid: `${classId}-class`, classId, parentClassId: "Actor", anchors: [], entryPoints: [], source: "",
  ...(Object.keys(properties).length ? { components: [{ id: "mesh", classId: "MeshComponent", properties }] } : {}),
});

const sceneActor = (extra: Parameters<typeof createActor>[2] = {}) => (properties: Record<string, unknown>, x: number) =>
  createActor(`actor-${x}`, `Actor ${x}`, { transform: sceneTransform(x), components: bakedMesh(properties), ...extra });

let runtime: RuntimeDriver | undefined;
afterEach(() => runtime?.stop());

async function start(actors: ReturnType<typeof createActor>[], scripts: CompiledScript[] = []) {
  runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, physicsWorld: "3d", gravity: [0, 0, 0],
    playScene: { name: "Placement", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors },
  });
  await runtime.loadScripts(scripts);
  runtime.registerModelContent({
    models: new Map([[SOLID, normalizeModelPayload({ simpleColliders: [solidShape] })], [HOLLOW, normalizeModelPayload({})]]),
    complexMeshes: new Map([[SOLID, { positions: box.positions, indices: box.indices }]]),
  });
  await runtime.realizePlayWorld();
  runtime.start();
  runtime.tick();
  return runtime;
}

const bodiesAt = (target: RuntimeDriver, x: number) =>
  target.getPhysicsSync()!.getBackend().sphereOverlap({ x, y: 0, z: 0 }, 0.2).actorIds;

describe("Mesh collision builds an implicit static body", () => {
  it.each(["scene actor", "placed Class instance", "Prefab instance"])("on a %s", async (path) => {
    const extra = path === "placed Class instance" ? { classId: "Statue" } : path === "Prefab instance" ? { prefabGuid: "prefab-1" } : {};
    const actors = cases.map((entry, index) => sceneActor(extra)(entry.properties, index * 10));
    const target = await start(actors, path === "placed Class instance" ? [classScript("Statue")] : []);
    for (const [index, entry] of cases.entries()) {
      const hit = bodiesAt(target, index * 10).includes(`actor-${index * 10}`);
      expect(hit, entry.name).toBe(entry.solid);
    }
  });

  it("on a runtime-spawned Class", async () => {
    const target = await start([], cases.map((entry, index) => classScript(`Spawned${index}`, { ...entry.properties })));
    const spawned = cases.map((_, index) => target.spawnScriptedActor({ classId: `Spawned${index}`, transform: at(index * 10) })!);
    target.tick();
    for (const [index, entry] of cases.entries())
      expect(bodiesAt(target, index * 10).includes(spawned[index]!.guid), entry.name).toBe(entry.solid);
  });
});
