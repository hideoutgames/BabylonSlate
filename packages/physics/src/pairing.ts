export type PhysicsPairingWarning = {
  severity: "warning";
  code:
    | "physics.collider_without_body"
    | "physics.body_without_collider"
    | "physics.movement_conflict"
    | "physics.mesh_collision_empty"
    | "physics.mesh_collision_2d";
  message: string;
  actorId: string;
  componentId: string;
};

export type PhysicsActorLike = {
  id: string;
  components: readonly {
    id: string;
    classId: string;
    properties?: Record<string, unknown>;
  }[];
};

/** What the caller knows beyond the actor's own components. Every field is optional; an unknown never warns. */
export type PhysicsDiagnosticsContext = {
  /**
   * The physics world the actors simulate in. Omit it for actors that can be placed in either
   * (a Class prefab): Mesh collision is then assumed to apply and the 2D check is skipped.
   */
  physicsWorld?: "2d" | "3d";
  /** Simple collision shapes of the Model `assetGuid`, or undefined when the Model is not known. */
  modelSimpleColliderCount?: (assetGuid: string) => number | undefined;
};

const FIX_FOR_BODY_3D =
  "Add a Rigid Body (Motion Type Static for a trigger volume or a fixed collider), or set a Mesh's Collision to Use Simple Collision or Use Complex Collision for solid geometry.";
const FIX_FOR_BODY_2D =
  "Add a Rigid Body (Motion Type Static for a trigger volume or a fixed collider).";
const FIX_FOR_COLLIDER_3D =
  "Add a Collider, or set a Mesh's Collision to Use Simple Collision or Use Complex Collision.";
const FIX_FOR_COLLIDER_2D = "Add a Collider.";
const MESH_COLLISION_EMPTY =
  "Use Simple Collision produces no collision because this Model has no simple collision shapes. Set Collision to Use Complex Collision, or add shapes to the Model's Colliders.";
const MESH_COLLISION_2D =
  "Mesh Collision works only in a 3D physics world, so this Mesh does not collide. Set Physics World to 3D (Havok), or give the actor a Rigid Body and a 2D Collider.";

const MOVEMENT_CONFLICTS = new Map([
  ["NavAgentComponent", "Nav Agent"],
  ["RagdollComponent", "Ragdoll"],
  ["WaterBuoyancyComponent", "Water Buoyancy"],
]);

type Component = PhysicsActorLike["components"][number];

/** A missing mode reads as Use Simple Collision, as `parseMeshCollisionMode` does. */
function meshCollisionMode(component: Component): "simple" | "complex" | "none" {
  const mode = component.properties?.collisionMode;
  return mode === "complex" || mode === "none" ? mode : "simple";
}

function modelGuid(component: Component): string {
  const guid = component.properties?.assetGuid;
  return typeof guid === "string" ? guid.trim() : "";
}

/** Use Simple Collision on a Model known to have no simple shapes: the runtime builds no body. */
function hasNoSimpleShapes(component: Component, context: PhysicsDiagnosticsContext): boolean {
  const guid = modelGuid(component);
  return meshCollisionMode(component) === "simple" && guid !== "" &&
    context.modelSimpleColliderCount?.(guid) === 0;
}

/**
 * Diagnose incompatible Movement owners, then body and shape pairs, as `PhysicsWorldSync` builds them:
 * a Rigid Body (or Water Buoyancy in 3D) or an implicit static body is a body; every Collider on the
 * actor attaches to whichever body it has, and Mesh collision, Blocking Volume, Tilemap, enabled
 * Landscape and enabled Dynamic Runtime Mesh supply both a static body and their own shapes.
 */
export function physicsActorDiagnostics(
  actor: PhysicsActorLike,
  context: PhysicsDiagnosticsContext = {},
): PhysicsPairingWarning[] {
  const live = actor.components.filter((component) => component.classId);
  const movements = live.filter((component) => component.classId === "MovementComponent");
  if (movements.length > 0) {
    const conflicts = [...new Set(live.flatMap((component) => {
      const label = MOVEMENT_CONFLICTS.get(component.classId);
      return label ? [label] : [];
    }))];
    // A dynamic Rigid Body is steered by Movement and a kinematic one is moved by it; a static one cannot move.
    const firstBody = live.find((component) => component.classId === "RigidBodyComponent");
    const problems = [
      ...(movements.length > 1 ? ["keep only one Movement component"] : []),
      ...(conflicts.length > 0 ? [`remove ${conflicts.join(", ")}`] : []),
      ...(firstBody?.properties?.motionType === "static" ? ["set the Rigid Body's Motion Type to Dynamic or Kinematic"] : []),
    ];
    if (problems.length > 0) {
      return movements.map((component) => ({
        severity: "warning",
        code: "physics.movement_conflict",
        message: `Movement cannot simulate on this actor: ${problems.join(" and ")}.`,
        actorId: actor.id,
        componentId: component.id,
      }));
    }
    // Movement owns the actor's body: its own capsule, or a Rigid Body with its own colliders or that capsule.
    return [];
  }
  const is3d = context.physicsWorld !== "2d";
  const warnings: PhysicsPairingWarning[] = [];
  const warn = (
    component: Component,
    code: PhysicsPairingWarning["code"],
    message: string,
  ) => warnings.push({ severity: "warning", code, message, actorId: actor.id, componentId: component.id });

  let meshShapes = false;
  for (const mesh of live) {
    if (mesh.classId !== "MeshComponent" || meshCollisionMode(mesh) === "none") continue;
    if (!is3d) warn(mesh, "physics.mesh_collision_2d", MESH_COLLISION_2D);
    else if (hasNoSimpleShapes(mesh, context)) warn(mesh, "physics.mesh_collision_empty", MESH_COLLISION_EMPTY);
    else meshShapes = true;
  }

  const ownShapes = meshShapes || live.some(
    (component) =>
      component.classId === "TilemapComponent" ||
      component.classId === "BlockingVolumeComponent" ||
      (is3d && component.classId === "LandscapeComponent" && component.properties?.collisionsEnabled === true) ||
      (is3d && component.classId === "DynamicRuntimeMeshComponent" && component.properties?.enableCollision === true),
  );
  const buoyancy = is3d && live.some((component) => component.classId === "WaterBuoyancyComponent");
  const rigidBody = live.find((component) => component.classId === "RigidBodyComponent");
  const colliders = live.filter((component) => component.classId === "ColliderComponent");

  if (!rigidBody && !buoyancy && !ownShapes) {
    for (const collider of colliders)
      warn(collider, "physics.collider_without_body", `Collider is not simulated without a Rigid Body on the same actor. ${is3d ? FIX_FOR_BODY_3D : FIX_FOR_BODY_2D}`);
  }
  if (rigidBody && colliders.length === 0 && !ownShapes && !buoyancy)
    warn(rigidBody, "physics.body_without_collider", `Rigid Body has no shape to collide with. ${is3d ? FIX_FOR_COLLIDER_3D : FIX_FOR_COLLIDER_2D}`);
  return warnings;
}

export function physicsActorsDiagnostics(
  actors: readonly PhysicsActorLike[],
  context: PhysicsDiagnosticsContext = {},
): PhysicsPairingWarning[] {
  return actors.flatMap((actor) => physicsActorDiagnostics(actor, context));
}
