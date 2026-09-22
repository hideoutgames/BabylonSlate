import { afterEach, describe, expect, it, vi } from "vitest";
import * as assets from "@babylonslate/assets";
import * as physics from "@babylonslate/physics";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { PhysicsWorldSync } from "./physics-sync";

afterEach(() => vi.restoreAllMocks());

function fixture(count: number) {
  const world = new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
  });
  const actors = Array.from({ length: count }, (_, index) => {
    const actor = world.createActor({
      classId: "Actor",
      guid: `actor-${index}`,
      transform: identityTransform(),
    });
    actor.transform.position.x = index * 4;
    actor.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        guid: `body-${index}`,
        variables: {
          motionType: "dynamic",
          mass: 1,
          gravityScale: 0,
          linearDamping: 0,
          angularDamping: 0,
        },
      }),
    );
    actor.attachComponent(
      world.createComponent({
        classId: "MeshComponent",
        guid: `mesh-${index}`,
        variables: { assetGuid: "mesh", collisionMode: "complex" },
      }),
    );
    world.spawnActorNow(actor);
    return actor;
  });
  const backend = physics.createSoftwarePhysicsBackend("3d", {
    x: 0,
    y: 0,
    z: 0,
  });
  const sync = new PhysicsWorldSync(backend);
  return { world, actors, backend, sync };
}

function triangles(count: number) {
  // Numeric collision fixture: disconnected nondegenerate triangles vary geometry
  // size without introducing a pathological native solver workload.
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const z = i / count;
    vertices.push({ x: 0, y: 0, z }, { x: 1, y: 0, z }, { x: 0, y: 1, z });
    indices.push(i * 3, i * 3 + 1, i * 3 + 2);
  }
  return { vertices, indices };
}

function install(
  sync: PhysicsWorldSync,
  geometry: ReturnType<typeof triangles>,
) {
  sync.setModelContent({
    models: {
      mesh: {
        materialSlots: [],
        clipNames: [],
        skeletonGuid: null,
        importScale: 1,
      },
    },
    complexMeshes: { mesh: geometry },
  });
}

describe("physics preparation work", () => {
  it.each([4, 2048])(
    "does no content-sized work for moving bodies with %i fixed triangles",
    (triangleCount) => {
      const { world, actors, backend, sync } = fixture(4);
      const geometry = triangles(triangleCount);
      const resolve = vi.spyOn(assets, "resolveMeshCollisions");
      const bake = vi.spyOn(physics, "bakeColliderLocal");
      const scaled = vi.spyOn(physics, "scaleColliderShape");
      const commit = vi.spyOn(backend, "applyColliderChanges");
      const serialize = vi.spyOn(JSON, "stringify");
      try {
        install(sync, geometry);
        sync.syncFromWorld(world);
        for (const actor of actors)
          sync.addImpulse(actor.guid, { x: 1, y: 0, z: 0 });
        resolve.mockClear();
        bake.mockClear();
        scaled.mockClear();
        commit.mockClear();
        serialize.mockClear();
        for (let tick = 0; tick < 20; tick++) sync.step(1 / 60, world);
        const geometrySerializations = serialize.mock.calls.filter(
          ([value]) => {
            const kind = (value as { shape?: { kind?: string } } | null)?.shape
              ?.kind;
            return kind === "mesh" || kind === "convex";
          },
        ).length;
        const counts = {
          triangleCount,
          resolves: resolve.mock.calls.length,
          bakes: bake.mock.calls.length,
          scaledShapes: scaled.mock.calls.length,
          geometrySerializations,
          commits: commit.mock.calls.length,
        };
        console.info("physics unchanged geometry operations", counts);
        expect(actors[0]!.transform.position.x).toBeGreaterThan(0);
        expect(counts).toEqual({
          triangleCount,
          resolves: 0,
          bakes: 0,
          scaledShapes: 0,
          geometrySerializations: 0,
          commits: 0,
        });
      } finally {
        sync.dispose();
      }
    },
  );

  it.each([128, 512, 2048])(
    "indexes the ordered actor list once for %i body readbacks",
    (bodyCount) => {
      const { world, actors, backend, sync } = fixture(bodyCount);
      const reads = vi.spyOn(world, "getActors");
      const bodyReads = vi.spyOn(backend, "getBodyTransform");
      const ordered = world.getActors();
      const scans = vi.spyOn(ordered, "find");
      try {
        install(sync, triangles(1));
        sync.syncFromWorld(world);
        sync.addImpulse(actors.at(-1)!.guid, { x: 1, y: 0, z: 0 });
        reads.mockClear();
        bodyReads.mockClear();
        scans.mockClear();
        sync.step(1 / 60, world);
        console.info("physics actor lookup operations", {
          bodyCount,
          actorListReads: reads.mock.calls.length,
          actorScans: scans.mock.calls.length,
          bodyReads: bodyReads.mock.calls.length,
        });
        expect(actors.at(-1)!.transform.position.x).toBeGreaterThan(
          (bodyCount - 1) * 4,
        );
        expect(reads).toHaveBeenCalledTimes(1);
        expect(scans).not.toHaveBeenCalled();
        expect(bodyReads).toHaveBeenCalledTimes(bodyCount);
        expect(world.getActors()).toEqual(actors);
      } finally {
        sync.dispose();
      }
    },
  );
});
