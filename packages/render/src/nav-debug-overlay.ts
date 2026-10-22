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
} from "@haptic/navigation";
import type { PhysicsWorldKind, SerializedActor } from "@haptic/core";
import {
  createNavDebugBlockerMesh,
  type EditorVolumeKind,
} from "./editor-volume";
import { markEditorHelperMesh } from "./helper-mesh";
import { shareHelperProgram } from "./helper-program";
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

/** The editor rereads the stored chunk after a save, which yields equal bytes in a new array. */
function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
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
  /** The request the live overlay was built for; cleared with it. */
  private applied: { bytes: Uint8Array | null; blockers: string; world: PhysicsWorldKind } | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  async sync(
    bytes: Uint8Array | null,
    blockers: readonly NavDebugBlockerPose[] = [],
    world: PhysicsWorldKind = "3d",
  ): Promise<void> {
    // Scene edits resync with an unchanged bake and unchanged blockers. Rebuilding adds and
    // disposes scene meshes and materials, which marks renderer readiness dirty for nothing.
    const request = { bytes, blockers: JSON.stringify(blockers), world };
    const applied = this.applied;
    if (applied && sameBytes(applied.bytes, request.bytes) && applied.blockers === request.blockers && applied.world === request.world && this.isLive()) return;
    this.clear();
    this.applied = request;
    const generation = this.generation;
    try {
      await this.build(bytes, blockers, world, generation);
    } catch (error) {
      // A failed build must not make the identical request a no-op.
      if (generation === this.generation) this.applied = null;
      throw error;
    }
  }

  private async build(
    bytes: Uint8Array | null,
    blockers: readonly NavDebugBlockerPose[],
    world: PhysicsWorldKind,
    generation: number,
  ): Promise<void> {
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
      const material = shareHelperProgram(new StandardMaterial("navmeshDebugMat", this.scene));
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

  /** Every mesh this overlay built is still in the scene. */
  private isLive(): boolean {
    return (this.mesh === null || !this.mesh.isDisposed()) && this.blockerMeshes.every((mesh) => !mesh.isDisposed());
  }

  clear(): void {
    this.generation += 1;
    this.applied = null;
    this.mesh?.dispose(false, true);
    this.mesh = null;
    for (const mesh of this.blockerMeshes) mesh.dispose();
    this.blockerMeshes = [];
  }

  dispose(): void {
    this.clear();
  }
}
