import { Color3, Mesh, StandardMaterial, VertexData, type Scene } from "@babylonjs/core";
import {
  initNavigation,
  navMeshDebugPrimitives,
} from "@babylonslate/navigation";

/**
 * Editor-only navmesh overlay. Recast has no published `@recast-navigation/babylon`
 * helper; primitives come from Recast `DebugDrawerUtils` and land as a Babylon mesh.
 */
export class NavMeshDebugOverlay {
  mesh: Mesh | null = null;
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  async sync(bytes: Uint8Array | null): Promise<void> {
    this.clear();
    if (!bytes || bytes.byteLength === 0) return;
    await initNavigation();
    const primitives = navMeshDebugPrimitives(bytes);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const primitive of primitives) {
      if (primitive.type !== "tris") continue;
      const start = positions.length / 3;
      for (const vertex of primitive.vertices) {
        positions.push(vertex[0], vertex[1], vertex[2]);
      }
      for (let i = 0; i < primitive.vertices.length; i += 1) {
        indices.push(start + i);
      }
    }
    const mesh = new Mesh("navmeshDebug", this.scene);
    mesh.isPickable = false;
    const data = new VertexData();
    data.positions = positions.length > 0 ? positions : [0, 0, 0, 1, 0, 0, 0, 0, 1];
    data.indices = indices.length > 0 ? indices : [0, 1, 2];
    data.applyToMesh(mesh);
    const material = new StandardMaterial("navmeshDebugMat", this.scene);
    material.diffuseColor = new Color3(0.2, 0.7, 0.95);
    material.alpha = 0.35;
    material.backFaceCulling = false;
    material.wireframe = true;
    mesh.material = material;
    this.mesh = mesh;
  }

  clear(): void {
    this.mesh?.dispose();
    this.mesh = null;
  }

  dispose(): void {
    this.clear();
  }
}
