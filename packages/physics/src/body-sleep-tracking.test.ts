import { describe, expect, it } from "vitest";
import { HavokPhysicsBackend } from "./havok-backend";
import { Rapier2DPhysicsBackend } from "./rapier-backend";
import type { PhysicsTransform } from "./types";

const pose = (x = 0, y = 0, z = 0): PhysicsTransform => ({
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});

describe("backend didBodyMoveLastStep sleep and buffer-diff tracking", () => {
  it("Havok reports moved=true while falling, false once resting on a floor, and true again on impulse/teleport", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    try {
      backend.createBody({
        id: "floor",
        actorId: "floor",
        motionType: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, -0.5, 0),
      });
      backend.createCollider({
        id: "floor:col",
        bodyId: "floor",
        shape: { kind: "box", halfExtents: { x: 10, y: 0.5, z: 10 } },
        friction: 0.8,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 0xffffffff,
      });

      backend.createBody({
        id: "box",
        actorId: "box",
        motionType: "dynamic",
        mass: 1,
        linearDamping: 0.4,
        angularDamping: 0.4,
        gravityScale: 1,
        transform: pose(0, 1, 0),
      });
      backend.createCollider({
        id: "box:col",
        bodyId: "box",
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        friction: 0.8,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 0xffffffff,
      });

      expect(backend.didBodyMoveLastStep("floor")).toBe(false);
      backend.step(1 / 60);
      expect(backend.didBodyMoveLastStep("box")).toBe(true);

      // Step until the box settles and Havok's body buffer floats stay identical across steps.
      let settled = false;
      for (let i = 0; i < 300; i++) {
        backend.step(1 / 60);
        if (!backend.didBodyMoveLastStep("box")) {
          settled = true;
          break;
        }
      }
      expect(settled).toBe(true);
      expect(backend.didBodyMoveLastStep("box")).toBe(false);

      // An impulse wakes it immediately.
      backend.addImpulse("box", { x: 0, y: 6, z: 0 });
      expect(backend.didBodyMoveLastStep("box")).toBe(true);
      backend.step(1 / 60);
      expect(backend.didBodyMoveLastStep("box")).toBe(true);
    } finally {
      backend.dispose();
    }
  });

  it("Rapier 2D reports moved=true while falling, settles once on sleep, false while asleep, and true again on impulse", async () => {
    const backend = await Rapier2DPhysicsBackend.create({ kind: "2d", gravity: { x: 0, y: -9.81, z: 0 } });
    try {
      backend.createBody({
        id: "floor",
        actorId: "floor",
        motionType: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, -0.5, 0),
      });
      backend.createCollider({
        id: "floor:col",
        bodyId: "floor",
        shape: { kind: "box2d", halfExtents: { x: 10, y: 0.5 } },
        friction: 0.8,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 0xffffffff,
      });

      backend.createBody({
        id: "box",
        actorId: "box",
        motionType: "dynamic",
        mass: 1,
        linearDamping: 0.5,
        angularDamping: 0.5,
        gravityScale: 1,
        transform: pose(0, 1, 0),
      });
      backend.createCollider({
        id: "box:col",
        bodyId: "box",
        shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
        friction: 0.8,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 0xffffffff,
      });

      expect(backend.didBodyMoveLastStep("floor")).toBe(false);
      backend.step(1 / 60);
      expect(backend.didBodyMoveLastStep("box")).toBe(true);

      let settled = false;
      for (let i = 0; i < 300; i++) {
        backend.step(1 / 60);
        if (!backend.didBodyMoveLastStep("box")) {
          settled = true;
          break;
        }
      }
      expect(settled).toBe(true);
      expect(backend.didBodyMoveLastStep("box")).toBe(false);

      backend.addImpulse("box", { x: 0, y: 6, z: 0 });
      expect(backend.didBodyMoveLastStep("box")).toBe(true);
      backend.step(1 / 60);
      expect(backend.didBodyMoveLastStep("box")).toBe(true);
    } finally {
      backend.dispose();
    }
  });
});
