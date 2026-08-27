export type PhysicsPairingWarning = {
  severity: "warning";
  code: "physics.collider_without_body" | "physics.body_without_collider";
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

const COLLIDER_WITHOUT_BODY =
  "ColliderComponent needs a RigidBodyComponent on the same actor.";
const BODY_WITHOUT_COLLIDER =
  "RigidBodyComponent needs a ColliderComponent on the same actor.";

function meshComponentHasCollision(component: {
  classId: string;
  properties?: Record<string, unknown>;
}): boolean {
  if (component.classId !== "MeshComponent") return false;
  return component.properties?.collisionMode !== "none";
}

/** Pairing warnings for RigidBody / Collider. Tilemaps, blocking volumes, and Mesh collision are exempt. */
export function physicsActorDiagnostics(
  actor: PhysicsActorLike,
): PhysicsPairingWarning[] {
  const live = actor.components.filter((component) => component.classId);
  const hasImplicitBody = live.some(
    (component) =>
      component.classId === "TilemapComponent" ||
      component.classId === "BlockingVolumeComponent" ||
      meshComponentHasCollision(component),
  );
  if (hasImplicitBody) return [];
  const hasBody = live.some(
    (component) => component.classId === "RigidBodyComponent",
  );
  const colliders = live.filter(
    (component) => component.classId === "ColliderComponent",
  );
  const warnings: PhysicsPairingWarning[] = [];
  if (!hasBody) {
    for (const collider of colliders) {
      warnings.push({
        severity: "warning",
        code: "physics.collider_without_body",
        message: COLLIDER_WITHOUT_BODY,
        actorId: actor.id,
        componentId: collider.id,
      });
    }
    return warnings;
  }
  if (colliders.length === 0) {
    const body = live.find(
      (component) => component.classId === "RigidBodyComponent",
    );
    if (body) {
      warnings.push({
        severity: "warning",
        code: "physics.body_without_collider",
        message: BODY_WITHOUT_COLLIDER,
        actorId: actor.id,
        componentId: body.id,
      });
    }
  }
  return warnings;
}

export function physicsActorsDiagnostics(
  actors: readonly PhysicsActorLike[],
): PhysicsPairingWarning[] {
  return actors.flatMap((actor) => physicsActorDiagnostics(actor));
}
