import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
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
const NAVMESH_DEBUG_BLOCKER_COLOR = new Color3(0.1, 0.45, 0.18);

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

/** The editor-only stand-in that draws a Timeline Clip proxy's Shape representation. */
export const TIMELINE_PROXY_SHAPE_CLASS_ID = "TimelineProxyShapeComponent";

/** A Shape component's `#rrggbb` colour and 2D flag. */
export function timelineProxyShapeOptions(properties: Record<string, unknown>): { color: string; twoD: boolean } {
  return { color: typeof properties.color === "string" ? properties.color : "", twoD: properties.twoD === true };
}

/** Where the Shape's baked light comes from: above, a little to the right and towards a default camera. */
const SHAPE_LIGHT = new Vector3(0.35, 0.85, -0.4).normalize();

/**
 * A Timeline Clip proxy's Shape: a solid, opaque, pickable unit box in 3D or
 * square in 2D, in the proxy's colour; the proxy's Scale sizes it. The box's
 * faces are shaded by a fixed light baked into its vertex colours, so its
 * form reads under any viewport lighting, the unlit shading included.
 */
export function createTimelineProxyShapeMesh(scene: Scene, name: string, options: { color: string; twoD: boolean }): Mesh {
  const shape = options.twoD
    ? MeshBuilder.CreatePlane(name, { size: 1 }, scene)
    : MeshBuilder.CreateBox(name, { size: 1 }, scene);
  shape.metadata = { ...(shape.metadata ?? {}), editorVolume: true };
  shape.isPickable = true;
  shape.renderingGroupId = RENDERING_GROUP.world;
  if (!options.twoD) {
    const normals = shape.getVerticesData(VertexBuffer.NormalKind) ?? [];
    const colors: number[] = [];
    for (let index = 0; index < normals.length; index += 3) {
      const facing = normals[index]! * SHAPE_LIGHT.x + normals[index + 1]! * SHAPE_LIGHT.y + normals[index + 2]! * SHAPE_LIGHT.z;
      const shade = 0.55 + 0.45 * Math.max(0, facing);
      colors.push(shade, shade, shade, 1);
    }
    shape.setVerticesData(VertexBuffer.ColorKind, colors);
    shape.useVertexColors = true;
    shape.hasVertexAlpha = false;
  }
  const color = /^#[0-9a-f]{6}$/i.test(options.color) ? Color3.FromHexString(options.color) : COLLIDER_COLOR;
  setUnlitMaterial(shape, { textured: false, backFaceCulling: !options.twoD, fog: false, role: "helper" }, {
    texture: null, color: [color.r, color.g, color.b], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: options.twoD,
  });
  return shape;
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
