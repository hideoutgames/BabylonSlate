import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  type AbstractMesh,
} from "@babylonjs/core";
import {
  COLLIDER_COLOR,
  createColliderVisualMesh,
  createDashedEdgesMesh,
  cylinderEdges,
} from "./collider-visual";
import { RENDERING_GROUP } from "./sorting";

export const NAV_BLOCKER_VOLUME_COLOR = new Color3(1, 0.45, 0.15);
export const BLOCKING_VOLUME_COLOR = new Color3(0.35, 0.55, 1);
export const NAVMESH_DEBUG_BLOCKER_COLOR = new Color3(0.1, 0.45, 0.18);

export type EditorVolumeKind = "box" | "cylinder";

const volumeMaterials = new WeakMap<Scene, StandardMaterial>();

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
  fill.material = volumeFillMaterial(scene);
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

function volumeFillMaterial(scene: Scene): StandardMaterial {
  const existing = volumeMaterials.get(scene);
  if (existing) return existing;
  const material = new StandardMaterial("editorVolumeFill", scene);
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.diffuseColor = Color3.Black();
  material.emissiveColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.alpha = 0;
  material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  volumeMaterials.set(scene, material);
  return material;
}

export { COLLIDER_COLOR };
