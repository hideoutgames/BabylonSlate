import { describe, expect, it } from "vitest";
import { parseReflectionProbeProperties, reflectionProbeStaticActors } from "./reflection-probe";

type Actor = Parameters<typeof reflectionProbeStaticActors>[0][number];
const actor = (id: string, components: Actor["components"], extra: Partial<Actor> = {}): Actor =>
  ({ id, classId: "Actor", parentId: null, components, ...extra });

describe("reflection probes", () => {
  it("captures only logic-free actors whose components never move, under static parents", () => {
    const statics = reflectionProbeStaticActors([
      actor("wall", [{ classId: "MeshComponent" }, { classId: "ColliderComponent" }]),
      actor("sky", [{ classId: "SkyboxComponent" }]),
      actor("crate", [{ classId: "MeshComponent" }, { classId: "RigidBodyComponent", properties: { motionType: "dynamic" } }]),
      actor("ground", [{ classId: "MeshComponent" }, { classId: "RigidBodyComponent", properties: { motionType: "static" } }]),
      // A missing motion type is a dynamic body.
      actor("ball", [{ classId: "RigidBodyComponent" }]),
      actor("walker", [{ classId: "MeshComponent" }, { classId: "MovementComponent" }]),
      actor("fire", [{ classId: "ParticleComponent" }]),
      actor("scripted", [{ classId: "MeshComponent" }], { classId: "Door" }),
      actor("rider", [{ classId: "MeshComponent" }], { parentId: "walker" }),
      actor("shelf", [{ classId: "MeshComponent" }], { parentId: "wall" }),
      actor("orphan", [{ classId: "MeshComponent" }], { parentId: "gone" }),
      actor("cleared", [{ classId: "MeshComponent" }, { classId: "MovementComponent", destroyed: true }]),
    ]);
    expect([...statics].sort()).toEqual(["cleared", "ground", "shelf", "sky", "wall"]);
  });

  it("keeps a cycle of parents movable instead of recursing forever", () => {
    expect(reflectionProbeStaticActors([
      actor("a", [{ classId: "MeshComponent" }], { parentId: "b" }),
      actor("b", [{ classId: "MeshComponent" }], { parentId: "a" }),
    ]).size).toBe(0);
  });

  it("normalizes sizes and resolutions to supported values", () => {
    expect(parseReflectionProbeProperties({ size: [4, -1, "x"], resolution: 100, enabled: false }))
      .toEqual({ enabled: false, size: [4, 10, 10], resolution: 128 });
    expect(parseReflectionProbeProperties({ resolution: 256 }).resolution).toBe(256);
  });
});
