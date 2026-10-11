import {
  Color3,
  Color4,
  Matrix,
  Mesh,
  StandardMaterial,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import "@babylonjs/core/Rendering/edgesRenderer";
import {
  blockerWorldMatrix,
  initNavigation,
  navMeshDebugPrimitives,
} from "@babylonslate/navigation";
import type { PhysicsWorldKind, SerializedActor } from "@babylonslate/core";
import {
  createNavDebugBlockerMesh,
  type EditorVolumeKind,
} from "./editor-volume";
import { markEditorHelperMesh } from "./helper-mesh";
import { RENDERING_GROUP } from "./sorting";

export const NAVMESH_DEBUG_Y_OFFSET = 0.04;
export const NAVMESH_DEBUG_FILL = new Color3(0.18, 0.78, 0.32);
export const NAVMESH_DEBUG_EDGE = new Color4(0.06, 0.32, 0.12, 1);

export type NavDebugBlockerPose = {
  id: string;
  kind: EditorVolumeKind;
  /** World matrix of the unit volume in `Matrix.FromArray` order (16 entries). */
  world: readonly number[];
};

/** Each NavMesh Blocker at the world pose the bake carves it, through its parent chain. */
export function navDebugBlockersFromActors(
  actors: readonly SerializedActor[],
): NavDebugBlockerPose[] {
  const poses: NavDebugBlockerPose[] = [];
  let actorsById: Map<string, SerializedActor> | null = null;
  for (const actor of actors) {
    const component = actor.components.find(
      (entry) => entry.classId === "NavMeshBlockerComponent",
    );
    if (!component) continue;
    actorsById ??= new Map(actors.map((entry) => [entry.id, entry]));
    poses.push({
      id: actor.id,
      kind: component.properties.kind === "cylinder" ? "cylinder" : "box",
      world: blockerWorldMatrix(actor, actorsById),
    });
  }
  return poses;
}

/**
 * Editor and Play navmesh overlay. Recast has no published `@recast-navigation/babylon`
 * helper; primitives come from Recast `DebugDrawerUtils` and land as a Babylon mesh.
 */
export class NavMeshDebugOverlay {
  mesh: Mesh | null = null;
  blockerMeshes: Mesh[] = [];
  private readonly scene: Scene;
  private generation = 0;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  async sync(
    bytes: Uint8Array | null,
    blockers: readonly NavDebugBlockerPose[] = [],
    world: PhysicsWorldKind = "3d",
  ): Promise<void> {
    this.clear();
    const generation = this.generation;
    const positions: number[] = [];
    const indices: number[] = [];
    if (bytes && bytes.byteLength > 0) {
      await initNavigation();
      if (generation !== this.generation) return;
      const primitives = navMeshDebugPrimitives(bytes);
      for (const primitive of primitives) {
        if (primitive.type !== "tris") continue;
        const start = positions.length / 3;
        for (const vertex of primitive.vertices) {
          if (world === "2d") {
            positions.push(vertex[0], vertex[2], -NAVMESH_DEBUG_Y_OFFSET);
          } else {
            positions.push(vertex[0], vertex[1] + NAVMESH_DEBUG_Y_OFFSET, vertex[2]);
          }
        }
        for (let i = 0; i < primitive.vertices.length; i += 1) {
          indices.push(start + i);
        }
      }
    }
    // A bake with no walkable triangles draws no fill, only its blockers.
    if (positions.length > 0) {
      const mesh = new Mesh("navmeshDebug", this.scene);
      mesh.isPickable = false;
      markEditorHelperMesh(mesh);
      mesh.receiveShadows = false;
      const data = new VertexData();
      data.positions = positions;
      data.indices = indices;
      data.applyToMesh(mesh);
      const material = new StandardMaterial("navmeshDebugMat", this.scene);
      material.disableLighting = true;
      material.diffuseColor = Color3.Black();
      material.emissiveColor = NAVMESH_DEBUG_FILL.clone();
      material.specularColor = Color3.Black();
      material.alpha = 0.35;
      material.backFaceCulling = false;
      material.wireframe = false;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
      mesh.material = material;
      mesh.renderingGroupId = RENDERING_GROUP.world;
      mesh.enableEdgesRendering();
      mesh.edgesWidth = 2;
      mesh.edgesColor = NAVMESH_DEBUG_EDGE.clone();
      this.mesh = mesh;
    }
    for (const pose of blockers) {
      const mesh = createNavDebugBlockerMesh(
        this.scene,
        `navmeshDebug:blocker:${pose.id}`,
        pose.kind,
      );
      mesh.receiveShadows = false;
      // A pretransform keeps the shear a nonuniformly scaled parent gives a turned child.
      mesh.setPreTransformMatrix(Matrix.FromArray(pose.world));
      this.blockerMeshes.push(mesh);
    }
  }

  clear(): void {
    this.generation += 1;
    this.mesh?.dispose(false, true);
    this.mesh = null;
    for (const mesh of this.blockerMeshes) mesh.dispose();
    this.blockerMeshes = [];
  }

  dispose(): void {
    this.clear();
  }
}
