import { describe, expect, it } from "vitest";
import { physicsActorDiagnostics } from "./pairing";

describe("physicsActorDiagnostics", () => {
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
