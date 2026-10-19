import { describe, expect, it } from "vitest";
import { physicsActorDiagnostics, type PhysicsActorLike } from "./pairing";

describe("physicsActorDiagnostics", () => {
  it.each(["NavAgentComponent", "RagdollComponent", "WaterBuoyancyComponent"])(
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

  it("accepts a dynamic or kinematic Rigid Body beside Movement, and reports a static one that cannot move", () => {
    const actor = (properties?: Record<string, unknown>) => ({ id: "hero", components: [
      { id: "body", classId: "RigidBodyComponent", properties },
      { id: "motor", classId: "MovementComponent" },
    ] });
    // A missing Motion Type reads as Dynamic.
    expect(physicsActorDiagnostics(actor())).toEqual([]);
    expect(physicsActorDiagnostics(actor({ motionType: "dynamic" }))).toEqual([]);
    expect(physicsActorDiagnostics(actor({ motionType: "kinematic" }))).toEqual([]);
    expect(physicsActorDiagnostics(actor({ motionType: "static" }))).toEqual([
      expect.objectContaining({
        code: "physics.movement_conflict", componentId: "motor",
        message: "Movement cannot simulate on this actor: set the Rigid Body's Motion Type to Dynamic or Kinematic.",
      }),
    ]);
  });

  it("reports every Movement problem together", () => {
    expect(physicsActorDiagnostics({ id: "hero", components: [
      { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static" } },
      { id: "agent", classId: "NavAgentComponent" },
      { id: "motor", classId: "MovementComponent" },
    ] })).toEqual([
      expect.objectContaining({
        message: "Movement cannot simulate on this actor: remove Nav Agent and set the Rigid Body's Motion Type to Dynamic or Kinematic.",
      }),
    ]);
  });

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
  it("says a lone collider is not simulated and names the Rigid Body and Mesh Collision fixes", () => {
    const warnings = physicsActorDiagnostics({
      id: "lone-col",
      components: [{ id: "col", classId: "ColliderComponent" }],
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "physics.collider_without_body",
        actorId: "lone-col",
        componentId: "col",
      }),
    ]);
    expect(warnings[0]!.message).toMatch(/not simulated/);
    expect(warnings[0]!.message).toMatch(/Rigid Body \(Motion Type Static for a trigger volume/);
    expect(warnings[0]!.message).toMatch(/Mesh's Collision to Use Simple Collision or Use Complex Collision/);
  });

  it("does not suggest Mesh collision for a lone collider in a 2D world", () => {
    const [warning] = physicsActorDiagnostics(
      { id: "lone-col", components: [{ id: "col", classId: "ColliderComponent" }] },
      { physicsWorld: "2d" },
    );
    expect(warning?.code).toBe("physics.collider_without_body");
    expect(warning?.message).toMatch(/Rigid Body \(Motion Type Static/);
    expect(warning?.message).not.toMatch(/Mesh/);
  });

  it("says a rigid body has no shape and names the Collider and Mesh Collision fixes", () => {
    const warnings = physicsActorDiagnostics({
      id: "lone-rb",
      components: [{ id: "rb", classId: "RigidBodyComponent" }],
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "physics.body_without_collider",
        actorId: "lone-rb",
        componentId: "rb",
      }),
    ]);
    expect(warnings[0]!.message).toMatch(/no shape to collide with/);
    expect(warnings[0]!.message).toMatch(/Add a Collider, or set a Mesh's Collision/);
    const [twoD] = physicsActorDiagnostics(
      { id: "lone-rb", components: [{ id: "rb", classId: "RigidBodyComponent" }] },
      { physicsWorld: "2d" },
    );
    expect(twoD?.message).toMatch(/Add a Collider\./);
    expect(twoD?.message).not.toMatch(/Mesh/);
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
    const mesh = { id: "mesh", classId: "MeshComponent", properties: { collisionMode: "none" } };
    expect(physicsActorDiagnostics({ id: "deco", components: [mesh] })).toEqual([]);
    expect(
      physicsActorDiagnostics({ id: "deco-rb", components: [mesh, { id: "rb", classId: "RigidBodyComponent" }] })
        .map(({ code, componentId }) => ({ code, componentId })),
    ).toEqual([{ code: "physics.body_without_collider", componentId: "rb" }]);
    expect(
      physicsActorDiagnostics({ id: "deco-col", components: [mesh, { id: "col", classId: "ColliderComponent" }] })
        .map(({ code, componentId }) => ({ code, componentId })),
    ).toEqual([{ code: "physics.collider_without_body", componentId: "col" }]);
  });

  it("accepts a Collider on any actor whose body is an implicit one, as the runtime attaches its shape", () => {
    for (const source of [
      { id: "source", classId: "MeshComponent", properties: { collisionMode: "complex", assetGuid: "model" } },
      { id: "source", classId: "BlockingVolumeComponent" },
      { id: "source", classId: "TilemapComponent" },
      { id: "source", classId: "LandscapeComponent", properties: { collisionsEnabled: true } },
      { id: "source", classId: "DynamicRuntimeMeshComponent", properties: { enableCollision: true } },
    ]) {
      expect(
        physicsActorDiagnostics({ id: "trigger", components: [source, { id: "col", classId: "ColliderComponent" }] }),
        source.classId,
      ).toEqual([]);
    }
  });

  describe("Mesh collision that builds nothing", () => {
    const mesh = (properties: Record<string, unknown>) => ({ id: "mesh", classId: "MeshComponent", properties });
    const noShapes = { modelSimpleColliderCount: (guid: string) => (guid === "hollow" ? 0 : guid === "solid" ? 2 : undefined) };

    it("warns that Use Simple Collision on a Model without simple shapes produces no collision", () => {
      const warnings = physicsActorDiagnostics(
        { id: "statue", components: [mesh({ collisionMode: "simple", assetGuid: "hollow" })] },
        noShapes,
      );
      expect(warnings).toEqual([
        expect.objectContaining({ code: "physics.mesh_collision_empty", actorId: "statue", componentId: "mesh" }),
      ]);
      expect(warnings[0]!.message).toMatch(/Use Complex Collision/);
      expect(warnings[0]!.message).toMatch(/Colliders/);
    });

    it("stays quiet when shapes exist, when the Model is unknown, and for Complex, None and primitive meshes", () => {
      for (const properties of [
        { collisionMode: "simple", assetGuid: "solid" },
        { collisionMode: "simple", assetGuid: "missing" },
        { collisionMode: "complex", assetGuid: "hollow" },
        { collisionMode: "none", assetGuid: "hollow" },
        { collisionMode: "simple", meshKind: "sphere" },
        { collisionMode: "simple", assetGuid: "  " },
      ]) {
        expect(physicsActorDiagnostics({ id: "a", components: [mesh(properties)] }, noShapes), JSON.stringify(properties)).toEqual([]);
      }
      expect(physicsActorDiagnostics({ id: "a", components: [mesh({ collisionMode: "simple", assetGuid: "hollow" })] })).toEqual([]);
    });

    it("lets such a mesh supply neither a body nor shapes to its neighbours", () => {
      const hollow = mesh({ collisionMode: "simple", assetGuid: "hollow" });
      const codes = (...components: PhysicsActorLike["components"][number][]) =>
        physicsActorDiagnostics({ id: "a", components: [hollow, ...components] }, noShapes).map((warning) => warning.code);
      expect(codes({ id: "rb", classId: "RigidBodyComponent" })).toEqual([
        "physics.mesh_collision_empty",
        "physics.body_without_collider",
      ]);
      expect(codes({ id: "col", classId: "ColliderComponent" })).toEqual([
        "physics.mesh_collision_empty",
        "physics.collider_without_body",
      ]);
      expect(codes({ id: "rb", classId: "RigidBodyComponent" }, { id: "col", classId: "ColliderComponent" })).toEqual([
        "physics.mesh_collision_empty",
      ]);
    });

    it("lets a Mesh whose Model has shapes complete a Rigid Body", () => {
      const solid = mesh({ collisionMode: "simple", assetGuid: "solid" });
      expect(physicsActorDiagnostics({ id: "a", components: [solid, { id: "rb", classId: "RigidBodyComponent" }] }, noShapes)).toEqual([]);
    });

    it("warns for Mesh collision in a 2D physics world and skips the check when the world is unknown", () => {
      const actor = { id: "tile", components: [mesh({ collisionMode: "simple" })] };
      const warnings = physicsActorDiagnostics(actor, { physicsWorld: "2d" });
      expect(warnings).toEqual([
        expect.objectContaining({ code: "physics.mesh_collision_2d", actorId: "tile", componentId: "mesh" }),
      ]);
      expect(warnings[0]!.message).toMatch(/3D \(Havok\)/);
      expect(physicsActorDiagnostics(actor, { physicsWorld: "3d" })).toEqual([]);
      expect(physicsActorDiagnostics(actor)).toEqual([]);
      expect(physicsActorDiagnostics({ id: "tile", components: [mesh({ collisionMode: "none" })] }, { physicsWorld: "2d" })).toEqual([]);
    });

    it("does not let a 2D world's Mesh, Landscape or Dynamic Runtime Mesh complete a Rigid Body", () => {
      for (const source of [
        mesh({ collisionMode: "simple" }),
        { id: "source", classId: "LandscapeComponent", properties: { collisionsEnabled: true } },
        { id: "source", classId: "DynamicRuntimeMeshComponent", properties: { enableCollision: true } },
      ]) {
        const codes = physicsActorDiagnostics(
          { id: "a", components: [source, { id: "rb", classId: "RigidBodyComponent" }] },
          { physicsWorld: "2d" },
        ).map((warning) => warning.code);
        expect(codes, source.classId).toContain("physics.body_without_collider");
      }
    });
  });

  it("treats Water Buoyancy as a body with its own float shape in 3D only", () => {
    const buoyancy = { id: "float", classId: "WaterBuoyancyComponent" };
    expect(physicsActorDiagnostics({ id: "a", components: [buoyancy, { id: "col", classId: "ColliderComponent" }] })).toEqual([]);
    expect(physicsActorDiagnostics({ id: "a", components: [buoyancy, { id: "rb", classId: "RigidBodyComponent" }] })).toEqual([]);
    expect(
      physicsActorDiagnostics({ id: "a", components: [buoyancy, { id: "col", classId: "ColliderComponent" }] }, { physicsWorld: "2d" })
        .map((warning) => warning.code),
    ).toEqual(["physics.collider_without_body"]);
  });
});
