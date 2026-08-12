import { Color3, type AbstractMesh, type Mesh, type Scene } from "@babylonjs/core";

export const SELECTION_OUTLINE_COLOR = new Color3(0.35, 0.7, 1);
export const SELECTION_OUTLINE_WIDTH = 0.03;

/**
 * Mesh outline rather than a HighlightLayer pass: one extra draw per selected
 * mesh instead of a full-screen render target, which matters on the A16 iPad
 * baseline and keeps selection working under a NullEngine in tests.
 */
export class SelectionOutline {
  private readonly outlined = new Set<Mesh>();

  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  set(meshes: Iterable<AbstractMesh | null | undefined>): void {
    const next = new Set<Mesh>();
    for (const mesh of meshes) {
      if (!mesh) continue;
      const target = mesh as Mesh;
      next.add(target);
      if (!this.outlined.has(target)) {
        target.renderOutline = true;
        target.outlineColor = SELECTION_OUTLINE_COLOR;
        target.outlineWidth = SELECTION_OUTLINE_WIDTH;
      }
    }
    for (const mesh of this.outlined) {
      if (!next.has(mesh) && !mesh.isDisposed()) {
        mesh.renderOutline = false;
      }
    }
    this.outlined.clear();
    for (const mesh of next) {
      this.outlined.add(mesh);
    }
  }

  clear(): void {
    this.set([]);
  }

  /** Selected meshes still alive in the scene. */
  selected(): Mesh[] {
    return [...this.outlined].filter(
      (mesh) => !mesh.isDisposed() && this.scene.meshes.includes(mesh),
    );
  }

  dispose(): void {
    this.clear();
  }
}
