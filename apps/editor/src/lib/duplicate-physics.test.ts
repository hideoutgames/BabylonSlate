import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedActor,
} from "@babylonslate/core";
import { createInProcessRuntime } from "@babylonslate/runtime";
import { duplicateSceneActor } from "./place-actors";

function box(
  id: string,
  x: number,
  mode: "2d" | "3d",
  ground = false,
): SerializedActor {
  return createActor(id, id, {
    transform: {
      position: [x, ground ? 0 : 5, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    components: [
      {
        ...createMeshComponent(`${id}-mesh`, "box"),
        properties: { meshKind: "box", collisionMode: "none" },
      },
      {
        id: `${id}-body`,
        classId: "RigidBodyComponent",
        properties: {
          motionType: ground ? "static" : "dynamic",
          mass: ground ? 0 : 1,
          gravityScale: ground ? 0 : 1,
        },
      },
      {
        id: `${id}-collider`,
        classId: "ColliderComponent",
        properties: {
          shape: {
            kind: mode === "2d" ? "box2d" : "box",
            halfExtents: { x: ground ? 20 : 0.5, y: 0.5, z: ground ? 5 : 0.5 },
          },
        },
      },
    ],
  });
}

describe.each([
  ["2d", false],
  ["3d", false],
  ["2d", true],
  ["3d", true],
] as const)(
  "H1.4 duplicate collision in %s (software=%s)",
  (mode, software) => {
    it.each([false, true])(
      "all five separated boxes settle (duplicate=%s)",
      async (duplicate) => {
        const scene = createDefaultScene();
        scene.viewportMode = mode;
        scene.settings.physicsWorld = mode;
        scene.actors = [box("ground", 0, mode, true), box("actor-1", -6, mode)];
        const source = scene.actors[1]!;
        for (let i = 1; i < 5; i++) {
          scene.actors.push(
            duplicate
              ? duplicateSceneActor(scene, source, {
                  position: [-6 + i * 3, 5, 0],
                })
              : box(`actor-${i + 1}`, -6 + i * 3, mode),
          );
        }
        const runtime = createInProcessRuntime({
          seed: 1,
          seedDemoActors: false,
          preferSoftwarePhysics: software,
          physicsWorld: mode,
          playScene: scene,
          playSceneGuid: "duplicate-scene",
        });
        try {
          if (!software) await runtime.loadPhysics();
          expect(runtime.getPhysicsSync()!.getBackend().constructor.name).toBe(
            software
              ? "SoftwarePhysicsBackend"
              : mode === "2d"
                ? "Rapier2DPhysicsBackend"
                : "HavokPhysicsBackend",
          );
          runtime.realizePlayWorld();
          runtime.start();
          for (let i = 0; i < 240; i++) runtime.tick();
          const positions = scene.actors
            .slice(1)
            .map(
              (actor) =>
                runtime.getWorld().findActor(actor.id)!.transform.position.y,
            );
          expect(positions).toHaveLength(5);
          for (const [index, y] of positions.entries()) {
            expect(y).toBeGreaterThan(0.9);
            expect(y).toBeLessThan(1.1);
            const x = -6 + index * 3;
            expect(
              runtime
                .getPhysicsSync()!
                .lineTrace({ x, y: 10, z: 0 }, { x, y: 0.6, z: 0 }).bodyId,
            ).toBe(`body:${scene.actors[index + 1]!.id}`);
          }
          runtime.getWorld().destroyActor(source.id);
          for (let i = 0; i < 120; i++) runtime.tick();
          for (let i = 1; i < 5; i++) {
            const actor = scene.actors[i + 1]!;
            expect(
              runtime.getWorld().findActor(actor.id)!.transform.position.y,
            ).toBeGreaterThan(0.9);
            const x = -6 + i * 3;
            expect(
              runtime
                .getPhysicsSync()!
                .lineTrace({ x, y: 10, z: 0 }, { x, y: 0.6, z: 0 }).bodyId,
            ).toBe(`body:${actor.id}`);
          }
        } finally {
          runtime.stop();
        }
      },
    );
  },
);
