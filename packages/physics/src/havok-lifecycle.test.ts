import { describe, expect, it } from "vitest";
import { HavokPhysicsBackend } from "./havok-backend";
import type { ColliderDesc, PhysicsTransform } from "./types";

const pose = (x = 0, y = 0, z = 0): PhysicsTransform => ({
  position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 },
});
function body(backend: HavokPhysicsBackend, id = "body", motionType: "static" | "dynamic" | "kinematic" = "static") {
  backend.createBody({ id, actorId: id, motionType, mass: 2, linearDamping: 0,
    angularDamping: 0, gravityScale: 1, transform: pose() });
}
function box(id = "collider", x = 0): ColliderDesc {
  return { id, bodyId: "body", shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
    translation: { x, y: 0, z: 0 }, friction: 0.5, restitution: 0,
    isTrigger: false, layer: 1, mask: 0xffffffff };
}
const trace = (backend: HavokPhysicsBackend, x = 0) => backend.lineTrace({ x, y: 2, z: 0 }, { x, y: -2, z: 0 });

describe("Havok native collider lifetime", () => {
  it("removes the final collider natively while retaining its usable body", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    try {
      body(backend);
      backend.createCollider(box());
      const nativeBody = backend.getNativeBodyId("body");
      expect(nativeBody).not.toBeNull();
      expect(trace(backend).hit).toBe(true);
      backend.destroyCollider("collider");
      expect(trace(backend).hit).toBe(false);
      expect(backend.getNativeBodyId("body")).toBe(nativeBody);
      backend.createCollider(box());
      expect(trace(backend).hit).toBe(true);
    } finally { backend.dispose(); }
  });

  it("retires native first shapes and compound containers with their body", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    const havok = backend.havok;
    try {
      const nativeBaseline = havok.HP_GetStatistics()[1][1];
      body(backend);
      backend.createCollider(box("a", -2));
      backend.createCollider(box("b", 2));
      expect(havok.HP_GetStatistics()[1][1]).toBe(nativeBaseline + 3);
      backend.destroyBody("body");
      expect(havok.HP_GetStatistics()[1][1]).toBe(nativeBaseline);
    } finally { backend.dispose(); }
  });

  it("reclaims convex query helpers after repeated casts", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    try {
      const baseline = backend.havok.HP_GetStatistics()[1][1];
      const points = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 3 }];
      for (let i = 0; i < 8; i++) backend.shapeSweep({ kind: "convex", points }, pose(-5), pose(5));
      expect(backend.havok.HP_GetStatistics()[1][1]).toBe(baseline);
    } finally { backend.dispose(); }
  });
});
