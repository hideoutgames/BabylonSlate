import { describe, expect, it, beforeEach } from "vitest";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  loadedBackendModules,
  parseColliderProperties,
  parseRigidBodyProperties,
  resetLoadedBackendModules,
  type PhysicsBackend,
} from "./index";

function identity() {
  return {
    position: { x: 0, y: 5, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

async function runFallScenario(backend: PhysicsBackend): Promise<number> {
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
    shape:
      backend.kind === "2d"
        ? { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } }
        : { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
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
    shape:
      backend.kind === "2d"
        ? { kind: "box2d", halfExtents: { x: 5, y: 0.5 } }
        : { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
    friction: 0.5,
    restitution: 0,
    isTrigger: false,
    layer: 1,
    mask: 0xffffffff,
  });

  for (let i = 0; i < 120; i++) backend.step(1 / 60);
  const t = backend.getBodyTransform("dynamic");
  return t?.position.y ?? NaN;
}

describe("@babylonslate/physics", () => {
  beforeEach(() => {
    resetLoadedBackendModules();
  });

  it("parses rigid body and collider properties with defaults", () => {
    expect(parseRigidBodyProperties({})).toEqual({
      motionType: "dynamic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 1,
    });
    expect(parseColliderProperties({}, "3d").shape.kind).toBe("box");
    expect(parseColliderProperties({}, "2d").shape.kind).toBe("box2d");
  });

  it("software 3d: dynamic body falls and lineTrace hits ground", async () => {
    const backend = createSoftwarePhysicsBackend("3d", {
      x: 0,
      y: -9.81,
      z: 0,
    });
    const y = await runFallScenario(backend);
    expect(y).toBeLessThan(5);
    expect(y).toBeGreaterThanOrEqual(0.9);

    const hit = backend.lineTrace(
      { x: 0, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(hit.hit).toBe(true);
    expect(hit.actorId).toBeTruthy();
    backend.dispose();
  });

  it("software 2d: sphere overlap and character controller move", () => {
    const backend = createSoftwarePhysicsBackend("2d", {
      x: 0,
      y: -9.81,
      z: 0,
    });
    backend.createBody({
      id: "player",
      actorId: "p",
      motionType: "kinematic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      transform: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    backend.createCollider({
      id: "pc",
      bodyId: "player",
      shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
      friction: 0,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
    backend.createCharacterController({
      id: "cc",
      bodyId: "player",
      offset: 0.01,
    });
    const moved = backend.moveCharacter("cc", { x: 1, y: 0, z: 0 }, 1 / 60);
    expect(moved?.position.x).toBeCloseTo(1, 5);
    const overlap = backend.sphereOverlap({ x: 1, y: 1, z: 0 }, 1);
    expect(overlap.bodyIds).toContain("player");
    backend.dispose();
  });

  it("software destroyBody drops colliders and character controllers", () => {
    const backend = createSoftwarePhysicsBackend("2d", {
      x: 0,
      y: 0,
      z: 0,
    });
    backend.createBody({
      id: "player",
      actorId: "p",
      motionType: "kinematic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      transform: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    backend.createCollider({
      id: "pc",
      bodyId: "player",
      shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
      friction: 0,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
    backend.createCharacterController({
      id: "cc",
      bodyId: "player",
      offset: 0.01,
    });
    backend.destroyBody("player");
    expect(backend.moveCharacter("cc", { x: 1, y: 0, z: 0 }, 1 / 60)).toBeNull();
    expect(backend.sphereOverlap({ x: 0, y: 1, z: 0 }, 1).bodyIds).toEqual([]);
    expect(backend.getBodyTransform("player")).toBeNull();
    backend.dispose();
  });

  it("software destroyCharacterController stops later moves without destroying the body", () => {
    const backend = createSoftwarePhysicsBackend("2d", {
      x: 0,
      y: 0,
      z: 0,
    });
    backend.createBody({
      id: "player",
      actorId: "p",
      motionType: "kinematic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      transform: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    backend.createCharacterController({
      id: "cc",
      bodyId: "player",
      offset: 0.01,
    });
    backend.destroyCharacterController("cc");
    expect(backend.moveCharacter("cc", { x: 1, y: 0, z: 0 }, 1 / 60)).toBeNull();
    expect(backend.getBodyTransform("player")?.position.x).toBe(0);
    backend.dispose();
  });

  it("Rapier destroyBody also tears down the character controller", async () => {
    const backend = await createPhysicsBackend({
      kind: "2d",
      gravity: { x: 0, y: 0, z: 0 },
    });
    backend.createBody({
      id: "player",
      actorId: "p",
      motionType: "kinematic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      transform: {
        position: { x: 0, y: 1, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    backend.createCollider({
      id: "pc",
      bodyId: "player",
      shape: { kind: "box2d", halfExtents: { x: 0.4, y: 0.4 } },
      friction: 0,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
    backend.createCharacterController({
      id: "cc",
      bodyId: "player",
      offset: 0.01,
    });
    expect(backend.moveCharacter("cc", { x: 0.5, y: 0, z: 0 }, 1 / 60)).not.toBeNull();
    backend.destroyBody("player");
    expect(backend.moveCharacter("cc", { x: 1, y: 0, z: 0 }, 1 / 60)).toBeNull();
    expect(backend.getBodyTransform("player")).toBeNull();
    backend.dispose();
  });

  it("lazy factory loads only Havok for 3d worlds", async () => {
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    expect(loadedBackendModules.havok).toBe(true);
    expect(loadedBackendModules.rapier).toBe(false);
    expect(backend.kind).toBe("3d");
    const y = await runFallScenario(backend);
    expect(Number.isFinite(y)).toBe(true);
    backend.dispose();
  });

  it("Rapier closed chain colliders catch traces on every rectangle edge", async () => {
    const backend = await createPhysicsBackend({
      kind: "2d",
      gravity: { x: 0, y: 0, z: 0 },
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
      id: "loop",
      bodyId: "ground",
      shape: {
        kind: "chain",
        loop: true,
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
        ],
      },
      friction: 0.5,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
    const left = backend.lineTrace(
      { x: -1, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    );
    const right = backend.lineTrace(
      { x: 3, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    );
    const top = backend.lineTrace(
      { x: 1, y: 3, z: 0 },
      { x: 1, y: 1, z: 0 },
    );
    const bottom = backend.lineTrace(
      { x: 1, y: -1, z: 0 },
      { x: 1, y: 1, z: 0 },
    );
    expect(left?.hit).toBe(true);
    expect(right?.hit).toBe(true);
    expect(top?.hit).toBe(true);
    expect(bottom?.hit).toBe(true);
    backend.dispose();
  });

  it("lazy factory loads only Rapier for 2d worlds", async () => {
    resetLoadedBackendModules();
    const backend = await createPhysicsBackend({
      kind: "2d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    expect(loadedBackendModules.rapier).toBe(true);
    expect(loadedBackendModules.havok).toBe(false);
    expect(backend.kind).toBe("2d");
    const y = await runFallScenario(backend);
    expect(Number.isFinite(y)).toBe(true);
    backend.dispose();
  });

  it("parses extended collider shapes for both worlds", () => {
    expect(
      parseColliderProperties(
        { shape: { kind: "sphere", radius: 2 } },
        "3d",
      ).shape,
    ).toEqual({ kind: "sphere", radius: 2 });
    expect(
      parseColliderProperties(
        { shape: { kind: "circle", radius: 1 } },
        "2d",
      ).shape,
    ).toEqual({ kind: "circle", radius: 1 });
    expect(
      parseColliderProperties(
        {
          shape: {
            kind: "chain",
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
            ],
            loop: true,
          },
        },
        "2d",
      ).shape.kind,
    ).toBe("chain");
    expect(
      parseColliderProperties(
        {
          shape: {
            kind: "capsule2d",
            radius: 0.4,
            halfHeight: 1.2,
          },
        },
        "2d",
      ).shape,
    ).toEqual({ kind: "capsule2d", radius: 0.4, halfHeight: 1.2 });
    expect(
      parseColliderProperties(
        {
          shape: {
            kind: "polygon",
            points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, "bad"],
          },
        },
        "2d",
      ).shape,
    ).toEqual({
      kind: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
    });
    expect(
      parseColliderProperties(
        { shape: { kind: "capsule", radius: 0.3, halfHeight: 0.8 } },
        "3d",
      ).shape,
    ).toEqual({ kind: "capsule", radius: 0.3, halfHeight: 0.8 });
    expect(
      parseColliderProperties(
        { shape: { kind: "convex", points: "nope" } },
        "3d",
      ).shape,
    ).toEqual({ kind: "convex", points: [] });
    expect(
      parseColliderProperties(
        {
          shape: {
            kind: "mesh",
            vertices: [{ x: 1, y: 2, z: 3 }],
            indices: [0, "x", 2],
          },
        },
        "3d",
      ).shape,
    ).toEqual({
      kind: "mesh",
      vertices: [{ x: 1, y: 2, z: 3 }],
      indices: [0, 0, 2],
    });
    expect(
      parseColliderProperties({ shape: { kind: "unknown" } }, "3d").shape.kind,
    ).toBe("box");
    expect(
      parseColliderProperties({ shape: { kind: "unknown" } }, "2d").shape.kind,
    ).toBe("box2d");
    expect(
      parseRigidBodyProperties({ motionType: "kinematic", mass: 2 })
        .motionType,
    ).toBe("kinematic");
  });

  it("software shapeSweep and impulse move a dynamic body", () => {
    const backend = createSoftwarePhysicsBackend("3d", {
      x: 0,
      y: 0,
      z: 0,
    });
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
    const t = backend.getBodyTransform("a");
    expect(t!.position.x).toBeGreaterThan(0);
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
    backend.dispose();
  });

  it("offsets software collider AABBs by ColliderDesc translation", () => {
    const backend = createSoftwarePhysicsBackend("3d", {
      x: 0,
      y: 0,
      z: 0,
    });
    backend.createBody({
      id: "body",
      actorId: "actor",
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
      id: "col",
      bodyId: "body",
      shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      friction: 0.5,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
      translation: { x: 3, y: 0, z: 0 },
    });
    expect(backend.sphereOverlap({ x: 3, y: 0, z: 0 }, 0.2).bodyIds).toContain(
      "body",
    );
    expect(backend.sphereOverlap({ x: 0, y: 0, z: 0 }, 0.2).bodyIds).toEqual([]);
    backend.dispose();
  });

  it("preferSoftware never loads wasm backends", async () => {
    resetLoadedBackendModules();
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
      preferSoftware: true,
    });
    expect(loadedBackendModules.havok).toBe(false);
    expect(loadedBackendModules.rapier).toBe(false);
    backend.dispose();
  });
});
