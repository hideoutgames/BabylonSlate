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
