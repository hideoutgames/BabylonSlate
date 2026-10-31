import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  type AbstractMesh,
} from "@babylonjs/core";
import {
  COLLIDER_COLOR,
  createColliderVisualMesh,
  createDashedEdgesMesh,
  cylinderEdges,
} from "./collider-visual";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

/** An invisible pick fill: drawn at zero alpha from both sides, without fog. */
const VOLUME_FILL_MATERIAL: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: false, role: "helper" };
import { RENDERING_GROUP } from "./sorting";

export const NAV_BLOCKER_VOLUME_COLOR = new Color3(1, 0.45, 0.15);
export const BLOCKING_VOLUME_COLOR = new Color3(0.35, 0.55, 1);
export const NAVMESH_DEBUG_BLOCKER_COLOR = new Color3(0.1, 0.45, 0.18);

export type EditorVolumeKind = "box" | "cylinder";


export function isEditorVolumeMesh(mesh: AbstractMesh): boolean {
  return Boolean(
    (mesh.metadata as { editorVolume?: boolean } | null)?.editorVolume,
  );
}

/** Unit box/cylinder volume: pickable invisible fill + dotted outline. */
export function createEditorVolumeMesh(
  scene: Scene,
  name: string,
  kind: EditorVolumeKind,
  color: Color3,
): Mesh {
  const fill =
    kind === "cylinder"
      ? MeshBuilder.CreateCylinder(name, { height: 1, diameter: 1 }, scene)
      : MeshBuilder.CreateBox(name, { size: 1 }, scene);
  fill.metadata = { ...(fill.metadata ?? {}), editorVolume: true };
  fill.isPickable = true;
  fill.visibility = 1;
  fill.renderingGroupId = RENDERING_GROUP.world;
  applyVolumeFillMaterial(fill);
  const outline =
    kind === "cylinder"
      ? createDashedEdgesMesh(scene, `${name}:outline`, cylinderEdges(0.5, 1), color)
      : createColliderVisualMesh(
          scene,
          `${name}:outline`,
          { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
          color,
        );
  outline.parent = fill;
  return fill;
}

export function createNavDebugBlockerMesh(
  scene: Scene,
  name: string,
  kind: EditorVolumeKind,
): Mesh {
  const mesh = createEditorVolumeMesh(
    scene,
    name,
    kind,
    NAVMESH_DEBUG_BLOCKER_COLOR,
  );
  mesh.isPickable = false;
  return mesh;
}

/** Draws `mesh` as an invisible pick fill: black at zero alpha, blended. */
export function applyVolumeFillMaterial(mesh: AbstractMesh): void {
  setUnlitMaterial(mesh, VOLUME_FILL_MATERIAL, {
    texture: null, color: [0, 0, 0], alpha: 0, cutoff: 0, blend: true, textureAlpha: false, twoSided: false,
  });
}

export { COLLIDER_COLOR };
