import { describe, expect, it } from "vitest";
import { physicsActorDiagnostics } from "./pairing";

describe("physicsActorDiagnostics", () => {
  it.each(["RigidBodyComponent", "NavAgentComponent", "RagdollComponent", "WaterBuoyancyComponent"])(
    "reports a Movement conflict with %s even when a mesh supplies collision",
    (classId) => {
      const actor = { id: "hero", components: [
        { id: "visual", classId: "MeshComponent" },
        { id: "other-controller", classId },
        { id: "motor", classId: "MovementComponent" },
      ] };
      expect(physicsActorDiagnostics(actor)).toEqual([
        expect.objectContaining({
          severity: "warning", code: "physics.movement_conflict", actorId: "hero", componentId: "motor",
        }),
      ]);
      actor.components.splice(1, 1);
      expect(physicsActorDiagnostics(actor)).toEqual([]);
    },
  );

  it("locates duplicate Movement warnings on each motor and clears them when only one remains", () => {
    const actor = { id: "hero", components: [
      { id: "motor", classId: "MovementComponent" },
      { id: "extra-motor", classId: "MovementComponent" },
    ] };
    expect(physicsActorDiagnostics(actor)).toEqual([
      expect.objectContaining({ code: "physics.movement_conflict", componentId: "motor" }),
      expect.objectContaining({ code: "physics.movement_conflict", componentId: "extra-motor" }),
    ]);
    actor.components.pop();
    expect(physicsActorDiagnostics(actor)).toEqual([]);
  });

  it("does not suggest a conflicting rigid body for a Movement actor with an extra collider", () => {
    expect(physicsActorDiagnostics({ id: "mover", components: [
      { id: "movement", classId: "MovementComponent" },
      { id: "collider", classId: "ColliderComponent" },
    ] })).toEqual([]);
  });
  it("accepts an enabled runtime mesh as a rigid body's collision source", () => {
    const actor = { id: "mesh", components: [
      { id: "body", classId: "RigidBodyComponent", properties: {} },
      { id: "surface", classId: "DynamicRuntimeMeshComponent", properties: { enableCollision: true } },
    ] };
    expect(physicsActorDiagnostics(actor)).toEqual([]);
    actor.components[1]!.properties.enableCollision = false;
    expect(physicsActorDiagnostics(actor)[0]?.code).toBe("physics.body_without_collider");
  });
  it("warns when a collider has no rigid body and no tilemap", () => {
    expect(
      physicsActorDiagnostics({
        id: "lone-col",
        components: [{ id: "col", classId: "ColliderComponent" }],
      }),
    ).toEqual([
      {
        severity: "warning",
        code: "physics.collider_without_body",
        message: "ColliderComponent needs a RigidBodyComponent on the same actor.",
        actorId: "lone-col",
        componentId: "col",
      },
    ]);
  });

  it("warns when a rigid body has no collider and no tilemap", () => {
    expect(
      physicsActorDiagnostics({
        id: "lone-rb",
        components: [{ id: "rb", classId: "RigidBodyComponent" }],
      }),
    ).toEqual([
      {
        severity: "warning",
        code: "physics.body_without_collider",
        message: "RigidBodyComponent needs a ColliderComponent on the same actor.",
        actorId: "lone-rb",
        componentId: "rb",
      },
    ]);
  });

  it("does not warn when rigid body and collider are paired", () => {
    expect(
      physicsActorDiagnostics({
        id: "paired",
        components: [
          { id: "rb", classId: "RigidBodyComponent" },
          { id: "col", classId: "ColliderComponent" },
        ],
      }),
    ).toEqual([]);
  });

  it("does not warn for a blocking volume with or without an extra collider", () => {
    expect(
      physicsActorDiagnostics({
        id: "wall",
        components: [{ id: "vol", classId: "BlockingVolumeComponent" }],
      }),
    ).toEqual([]);
    expect(
      physicsActorDiagnostics({
        id: "wall-col",
        components: [
          { id: "vol", classId: "BlockingVolumeComponent" },
          { id: "col", classId: "ColliderComponent" },
        ],
      }),
    ).toEqual([]);
  });

  it("does not warn for a tilemap with or without a rigid body", () => {
    expect(
      physicsActorDiagnostics({
        id: "tiles",
        components: [{ id: "map", classId: "TilemapComponent" }],
      }),
    ).toEqual([]);
    expect(
      physicsActorDiagnostics({
        id: "tiles-rb",
        components: [
          { id: "map", classId: "TilemapComponent" },
          { id: "rb", classId: "RigidBodyComponent" },
        ],
      }),
    ).toEqual([]);
    expect(
      physicsActorDiagnostics({
        id: "tiles-col",
        components: [
          { id: "map", classId: "TilemapComponent" },
          { id: "col", classId: "ColliderComponent" },
        ],
      }),
    ).toEqual([]);
  });

  it("treats MeshComponent simple collision as an implicit body and collider", () => {
    expect(
      physicsActorDiagnostics({
        id: "crate",
        components: [{ id: "mesh", classId: "MeshComponent" }],
      }),
    ).toEqual([]);
    expect(
      physicsActorDiagnostics({
        id: "crate-rb",
        components: [
          { id: "mesh", classId: "MeshComponent" },
          { id: "rb", classId: "RigidBodyComponent" },
        ],
      }),
    ).toEqual([]);
    expect(
      physicsActorDiagnostics({
        id: "crate-col",
        components: [
          { id: "mesh", classId: "MeshComponent", properties: { collisionMode: "simple" } },
          { id: "col", classId: "ColliderComponent" },
        ],
      }),
    ).toEqual([]);
  });

  it("treats a Landscape as an implicit body and collider only when enabled", () => {
    for (const classId of ["RigidBodyComponent", "ColliderComponent"]) {
      const actor = { id: "terrain", components: [
        { id: "landscape", classId: "LandscapeComponent", properties: { collisionsEnabled: false } },
        { id: "physics", classId },
      ] };
      expect(physicsActorDiagnostics(actor)).toHaveLength(1);
      actor.components[0]!.properties!.collisionsEnabled = true;
      expect(physicsActorDiagnostics(actor)).toEqual([]);
    }
  });

  it("does not treat No Collision MeshComponent as a physics source", () => {
    expect(
      physicsActorDiagnostics({
        id: "deco",
        components: [
          {
            id: "mesh",
            classId: "MeshComponent",
            properties: { collisionMode: "none" },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      physicsActorDiagnostics({
        id: "deco-rb",
        components: [
          {
            id: "mesh",
            classId: "MeshComponent",
            properties: { collisionMode: "none" },
          },
          { id: "rb", classId: "RigidBodyComponent" },
        ],
      }),
    ).toEqual([
      {
        severity: "warning",
        code: "physics.body_without_collider",
        message: "RigidBodyComponent needs a ColliderComponent on the same actor.",
        actorId: "deco-rb",
        componentId: "rb",
      },
    ]);
  });
});
