import { describe, expect, it, beforeEach } from "vitest";
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
 * Inspection surface the Babylon Physics V2 backend must expose so tests
 * (and only tests) can assert we are driving HavokPlugin, not a custom AABB
 * stepper. Production code will grow these fields; they are absent today.
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
  beforeEach(() => {
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

  it("createCollider attaches a PhysicsBody via PhysicsAggregate", async () => {
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

    const hit = backend.lineTrace(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(hit.hit).toBe(true);
    expect(hit.actorId).toBeTruthy();
    expect((backend as unknown as HavokV2Surface).plugin).toBeInstanceOf(
      HavokPlugin,
    );
    backend.dispose();
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
