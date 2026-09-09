import {
  LinesMesh,
  Matrix,
  Mesh,
  Quaternion,
  Vector3,
  type Node,
} from "@babylonjs/core";
import type { SerializedScene, SerializedTransform } from "@babylonslate/core";
import type { MeshAssetContext } from "./mesh-assets";
import { isColliderVisualTree } from "./collider-visual";
import {
  collisionSurfaces,
  collisionBounds,
  surfaceHit,
  type DropBounds,
} from "./editor-drop-collisions";

export type EditorDropTransform = SerializedTransform & { actorId: string };

const MAX_DISTANCE = 10_000;
const EPS = 1e-8;

function dropTransformMatrix(transform: SerializedTransform): Matrix {
  return Matrix.Compose(
    new Vector3(...transform.scale),
    new Quaternion(...transform.rotation),
    new Vector3(...transform.position),
  );
}

/** Bottom-center collision query. Does not mutate authored data or live meshes. */
export function calculateEditorDropTransforms(options: {
  sceneData: SerializedScene;
  selectedActorIds: readonly string[];
  meshForActor: (id: string) => Mesh | null;
  assets?: MeshAssetContext;
}): EditorDropTransform[] {
  const { sceneData, meshForActor, assets } = options;
  const actors = new Map(sceneData.actors.map((actor) => [actor.id, actor]));
  const selected = new Set(
    options.selectedActorIds.filter((id) => {
      const actor = actors.get(id);
      return actor && !actor.locked;
    }),
  );
  if (selected.size === 0) return [];
  const worlds = new Map<string, Matrix>();
  const resolving = new Set<string>();
  const worldFor = (id: string): Matrix => {
    const known = worlds.get(id);
    if (known) return known;
    const actor = actors.get(id);
    if (!actor || resolving.has(id)) return Matrix.Identity();
    resolving.add(id);
    const local = dropTransformMatrix(actor.transform);
    const world = actor.parentId
      ? local.multiply(worldFor(actor.parentId))
      : local;
    resolving.delete(id);
    worlds.set(id, world);
    return world;
  };
  for (const id of actors.keys()) worldFor(id);
  const surfaces = collisionSurfaces(sceneData, assets);
  const moving = new Set(selected);
  for (const actor of sceneData.actors) {
    let parent = actor.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) {
        moving.add(actor.id);
        break;
      }
      seen.add(parent);
      parent = actors.get(parent)?.parentId ?? null;
    }
  }
  const targets = surfaces.filter((surface) => !moving.has(surface.actorId));
  const actorRoots = new Set(
    sceneData.actors
      .map((actor) => meshForActor(actor.id))
      .filter((root) => root !== null),
  );
  const displacements = new Map<string, number>();
  for (const actor of sceneData.actors) {
    if (!selected.has(actor.id)) continue;
    const worldPosition = worldFor(actor.id).getTranslation();
    const bounds =
      sourceBounds(meshForActor(actor.id), actorRoots) ??
      collisionBounds(
        surfaces.filter((surface) => surface.actorId === actor.id),
      );
    const origin = bounds
      ? new Vector3(
          (bounds.min.x + bounds.max.x) / 2,
          bounds.min.y,
          (bounds.min.z + bounds.max.z) / 2,
        )
      : worldPosition.clone();
    let distance = MAX_DISTANCE;
    for (const surface of targets) {
      const hit = surfaceHit(surface, origin);
      if (hit !== null && hit >= 0 && hit < distance) distance = hit;
    }
    displacements.set(
      actor.id,
      distance > EPS && distance < MAX_DISTANCE ? -distance : 0,
    );
  }
  // A selected no-hit child retains its world pose even if its parent drops.
  const finalDisplacements = new Map<string, number>();
  const finalResolving = new Set<string>();
  const displacementFor = (id: string): number => {
    const cached = finalDisplacements.get(id);
    if (cached !== undefined) return cached;
    const actor = actors.get(id);
    if (!actor || finalResolving.has(id)) return 0;
    finalResolving.add(id);
    const displacement =
      displacements.get(id) ??
      (actor.parentId ? displacementFor(actor.parentId) : 0);
    finalResolving.delete(id);
    finalDisplacements.set(id, displacement);
    return displacement;
  };
  const changes: EditorDropTransform[] = [];
  for (const actor of sceneData.actors) {
    const displacement = displacements.get(actor.id);
    if (displacement === undefined) continue;
    const relativeDisplacement =
      displacement - (actor.parentId ? displacementFor(actor.parentId) : 0);
    if (Math.abs(relativeDisplacement) <= EPS) continue;
    const parentWorld = actor.parentId
      ? worldFor(actor.parentId)
      : Matrix.Identity();
    const determinant = parentWorld.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) continue;
    const localDelta = Vector3.TransformNormal(
      new Vector3(0, relativeDisplacement, 0),
      Matrix.Invert(parentWorld),
    );
    const local = new Vector3(...actor.transform.position).add(localDelta);
    changes.push({
      actorId: actor.id,
      position: [local.x, local.y, local.z],
      rotation: [...actor.transform.rotation],
      scale: [...actor.transform.scale],
    });
  }
  return changes;
}

function sourceBounds(
  root: Mesh | null,
  actorRoots: ReadonlySet<Mesh>,
): DropBounds | null {
  if (!root) return null;
  let bounds: DropBounds | null = null;
  for (const mesh of [root, ...root.getChildMeshes()]) {
    let owner: Node = mesh;
    while (owner.parent && !actorRoots.has(owner as Mesh)) owner = owner.parent;
    if (
      owner !== root ||
      mesh instanceof LinesMesh ||
      mesh.getTotalVertices() === 0 ||
      isColliderVisualTree(mesh)
    )
      continue;
    const meta = mesh.metadata as {
      editorPickProxy?: boolean;
      editorBillboard?: string;
      editorVolume?: boolean;
    } | null;
    if (
      meta?.editorPickProxy ||
      meta?.editorBillboard ||
      meta?.editorVolume ||
      mesh.visibility === 0 ||
      mesh.infiniteDistance
    )
      continue;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    if (!bounds)
      bounds = { min: box.minimumWorld.clone(), max: box.maximumWorld.clone() };
    else {
      Vector3.CheckExtends(box.minimumWorld, bounds.min, bounds.max);
      Vector3.CheckExtends(box.maximumWorld, bounds.min, bounds.max);
    }
  }
  return bounds;
}
