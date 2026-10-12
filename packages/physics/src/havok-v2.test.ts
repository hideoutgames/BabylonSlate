import { describe, expect, it, beforeAll } from "vitest";
import "@babylonjs/core/Physics/physicsEngineComponent";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { Scene } from "@babylonjs/core/scene";
import {
  createPhysicsBackend,
  HavokPhysicsBackend,
  resetLoadedBackendModules,
  type PhysicsBackend,
} from "./index";
import { resetHavokModuleCache } from "./havok-loader";

/**
 * Inspection surface the Babylon Physics V2 backend exposes so tests can
 * assert we are driving HavokPlugin, not a custom AABB stepper.
 * `plugin` and `scene` are public fields on `HavokPhysicsBackend`.
 */
type HavokV2Surface = {
  plugin?: unknown;
  scene?: unknown;
};

function identity() {
  return {
    position: { x: 0, y: 5, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

function spawnFallingBox(backend: PhysicsBackend): void {
  backend.createBody({
    id: "dynamic",
    actorId: "actor-a",
    motionType: "dynamic",
    mass: 1,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    transform: identity(),
  });
  backend.createCollider({
    id: "col-a",
    bodyId: "dynamic",
    shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    friction: 0.5,
    restitution: 0,
    isTrigger: false,
    layer: 1,
    mask: 0xffffffff,
  });
  backend.createBody({
    id: "ground",
    actorId: "actor-ground",
    motionType: "static",
    mass: 0,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 0,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  });
  backend.createCollider({
    id: "col-g",
    bodyId: "ground",
    shape: { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
    friction: 0.5,
    restitution: 0,
    isTrigger: false,
    layer: 1,
    mask: 0xffffffff,
  });
}

describe("Havok 3D backend uses Babylon Physics V2", () => {
  beforeAll(() => {
    resetLoadedBackendModules();
    resetHavokModuleCache();
  });

  it("createPhysicsBackend(3d) drives a HavokPlugin on a NullEngine Scene", async () => {
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    expect(backend).toBeInstanceOf(HavokPhysicsBackend);
    const surface = backend as unknown as HavokV2Surface;
    expect(surface.plugin).toBeInstanceOf(HavokPlugin);
    expect(surface.scene).toBeInstanceOf(Scene);
    const scene = surface.scene as Scene;
    expect(scene.getPhysicsEngine()?.getPhysicsPlugin()).toBeInstanceOf(
      HavokPlugin,
    );
    backend.dispose();
  });

  it("createCollider attaches a collider to its explicitly owned PhysicsBody", async () => {
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    spawnFallingBox(backend);
    const scene = (backend as unknown as HavokV2Surface).scene;
    expect(scene).toBeInstanceOf(Scene);
    const node = (scene as Scene).getTransformNodeByName("dynamic");
    expect(node?.physicsBody).toBeInstanceOf(PhysicsBody);
    backend.dispose();
  });

  it("HavokPlugin steps a dynamic box onto static ground and raycast hits", async () => {
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    spawnFallingBox(backend);
    for (let i = 0; i < 120; i++) backend.step(1 / 60);
    const y = backend.getBodyTransform("dynamic")?.position.y ?? NaN;
    expect(y).toBeLessThan(4.5);
    expect(y).toBeGreaterThan(0.5);

    const hit = backend.lineTrace({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(hit.hit).toBe(true);
    expect(hit.actorId).toBeTruthy();
    expect((backend as unknown as HavokV2Surface).plugin).toBeInstanceOf(
      HavokPlugin,
    );
    backend.dispose();
  });

  it("horizontal velocity updates preserve a dynamic body's accumulated fall", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    try {
      spawnFallingBox(backend);
      for (let i = 0; i < 15; i += 1) backend.step(1 / 60);
      const before = backend.getBodyTransform("dynamic")!.position;
      for (let i = 0; i < 15; i += 1) {
        backend.setBodyLinearVelocity("dynamic", { x: 2, z: 0 });
        backend.step(1 / 60);
      }
      const after = backend.getBodyTransform("dynamic")!.position;
      expect(after.x - before.x).toBeCloseTo(0.5, 1);
      expect(after.y).toBeLessThan(before.y - 0.7);
      backend.setBodyLinearVelocity("dynamic", { x: 0, z: 0 });
      const stopped = backend.getBodyTransform("dynamic")!.position;
      backend.step(1 / 60);
      expect(backend.getBodyTransform("dynamic")!.position.x).toBeCloseTo(stopped.x, 5);
      expect(backend.getBodyTransform("dynamic")!.position.y).toBeLessThan(stopped.y);
    } finally {
      backend.dispose();
    }
  });

  it("names the hosted shape a contact touched on a rotated compound", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    const half = Math.SQRT1_2;
    const solid = { friction: 0.5, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff };
    const staticBody = (id: string, z: number) => {
      backend.createBody({
        id, actorId: id, motionType: "static", mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0,
        transform: { position: { x: 0, y: -0.5, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      });
      backend.createCollider({ id: `${id}-box`, bodyId: id, shape: { kind: "box", halfExtents: { x: 1, y: 0.5, z: 0.75 } }, ...solid });
    };
    try {
      staticBody("ground-plus-z", 1);
      staticBody("ground-minus-z", -1);
      // A quarter turn about Y carries local -x to world +z and local +x to world -z.
      backend.createBody({
        id: "crate", actorId: "crate", motionType: "dynamic", mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 1,
        transform: { position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: half, z: 0, w: half } },
      });
      backend.applyColliderChanges("crate", {
        upsert: [
          { id: "crate-box", bodyId: "crate", shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }, ...solid },
          {
            id: "foot-sphere", bodyId: "crate", actorId: "left-foot", ...solid,
            shape: { kind: "sphere", radius: 0.25 }, translation: { x: -1, y: -1, z: 0 },
          },
          {
            // Lies along local z (world x), so the two feet support the crate stably.
            id: "foot-capsule", bodyId: "crate", actorId: "right-foot", ...solid,
            shape: { kind: "capsule", radius: 0.25, halfHeight: 0.25 },
            translation: { x: 1, y: -1, z: 0 }, rotation: { x: half, y: 0, z: 0, w: half },
          },
        ],
        remove: [],
      });
      const touched = new Map<string, Set<string>>();
      for (let i = 0; i < 90; i++) {
        backend.step(1 / 60);
        for (const event of backend.pollContacts()) {
          if (event.kind !== "hit") continue;
          const groundIsA = event.actorAId.startsWith("ground");
          const ground = groundIsA ? event.actorAId : event.actorBId;
          const other = groundIsA ? `${event.actorBId}/${event.colliderBId}` : `${event.actorAId}/${event.colliderAId}`;
          touched.set(ground, (touched.get(ground) ?? new Set()).add(other));
        }
      }
      // The feet's bottoms (crate y - 1.25) rest on the grounds.
      expect(backend.getBodyTransform("crate")!.position.y).toBeCloseTo(1.25, 1);
      expect(touched).toEqual(new Map([
        ["ground-plus-z", new Set(["left-foot/foot-sphere"])],
        ["ground-minus-z", new Set(["right-foot/foot-capsule"])],
      ]));
    } finally {
      backend.dispose();
    }
  });

  it("HavokPlugin applyImpulse moves a dynamic body and shapeCast hits", async () => {
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: 0, z: 0 },
    });
    expect(backend).toBeInstanceOf(HavokPhysicsBackend);
    backend.createBody({
      id: "a",
      actorId: "actor",
      motionType: "dynamic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    backend.createCollider({
      id: "c",
      bodyId: "a",
      shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      friction: 0,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
    backend.addImpulse("a", { x: 10, y: 0, z: 0 }, 1);
    backend.step(1 / 60);
    expect(backend.getBodyTransform("a")!.position.x).toBeGreaterThan(0);
    const sweep = backend.shapeSweep(
      { kind: "sphere", radius: 0.25 },
      {
        position: { x: -5, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        position: { x: 5, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    );
    expect(sweep.hit).toBe(true);
    expect((backend as unknown as HavokV2Surface).plugin).toBeInstanceOf(
      HavokPlugin,
    );
    backend.dispose();
  });
});
