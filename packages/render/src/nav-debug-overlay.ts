import {
  Color3,
  Color4,
  Mesh,
  Quaternion,
  StandardMaterial,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import "@babylonjs/core/Rendering/edgesRenderer";
import {
  initNavigation,
  navMeshDebugPrimitives,
} from "@babylonslate/navigation";
import type { SerializedActor } from "@babylonslate/core";
import {
  createNavDebugBlockerMesh,
  type EditorVolumeKind,
} from "./editor-volume";
import { RENDERING_GROUP } from "./sorting";

export const NAVMESH_DEBUG_Y_OFFSET = 0.04;
export const NAVMESH_DEBUG_FILL = new Color3(0.18, 0.78, 0.32);
export const NAVMESH_DEBUG_EDGE = new Color4(0.06, 0.32, 0.12, 1);

export type NavDebugBlockerPose = {
  id: string;
  kind: EditorVolumeKind;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
};

export function navDebugBlockersFromActors(
  actors: readonly SerializedActor[],
): NavDebugBlockerPose[] {
  const poses: NavDebugBlockerPose[] = [];
  for (const actor of actors) {
    const component = actor.components.find(
      (entry) => entry.classId === "NavMeshBlockerComponent",
    );
    if (!component) continue;
    poses.push({
      id: actor.id,
      kind: component.properties.kind === "cylinder" ? "cylinder" : "box",
      position: actor.transform.position,
      rotation: actor.transform.rotation,
      scale: actor.transform.scale,
    });
  }
  return poses;
}

export function navmeshOverlayEnabled(scene: {
  settings: { showNavmesh?: boolean };
  actors: readonly SerializedActor[];
}): boolean {
  if (scene.settings.showNavmesh === true) return true;
  return scene.actors.some((actor) =>
    actor.components.some(
      (component) =>
        component.classId === "NavMeshComponent" &&
        component.properties.debugOverlay === true,
    ),
  );
}

/**
 * Editor-only navmesh overlay. Recast has no published `@recast-navigation/babylon`
 * helper; primitives come from Recast `DebugDrawerUtils` and land as a Babylon mesh.
 */
export class NavMeshDebugOverlay {
  mesh: Mesh | null = null;
  blockerMeshes: Mesh[] = [];
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  async sync(
    bytes: Uint8Array | null,
    blockers: readonly NavDebugBlockerPose[] = [],
  ): Promise<void> {
    this.clear();
    if (bytes && bytes.byteLength > 0) {
      await initNavigation();
      const primitives = navMeshDebugPrimitives(bytes);
      const positions: number[] = [];
      const indices: number[] = [];
      for (const primitive of primitives) {
        if (primitive.type !== "tris") continue;
        const start = positions.length / 3;
        for (const vertex of primitive.vertices) {
          positions.push(vertex[0], vertex[1] + NAVMESH_DEBUG_Y_OFFSET, vertex[2]);
        }
        for (let i = 0; i < primitive.vertices.length; i += 1) {
          indices.push(start + i);
        }
      }
      const mesh = new Mesh("navmeshDebug", this.scene);
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      const data = new VertexData();
      data.positions =
        positions.length > 0 ? positions : [0, NAVMESH_DEBUG_Y_OFFSET, 0, 1, NAVMESH_DEBUG_Y_OFFSET, 0, 0, NAVMESH_DEBUG_Y_OFFSET, 1];
      data.indices = indices.length > 0 ? indices : [0, 1, 2];
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
      mesh.position.set(pose.position[0], pose.position[1], pose.position[2]);
      mesh.rotationQuaternion = new Quaternion(
        pose.rotation[0],
        pose.rotation[1],
        pose.rotation[2],
        pose.rotation[3],
      );
      mesh.scaling.set(pose.scale[0], pose.scale[1], pose.scale[2]);
      this.blockerMeshes.push(mesh);
    }
  }

  clear(): void {
    this.mesh?.dispose();
    this.mesh = null;
    for (const mesh of this.blockerMeshes) mesh.dispose();
    this.blockerMeshes = [];
  }

  dispose(): void {
    this.clear();
  }
}
