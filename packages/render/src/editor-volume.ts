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

/** The editor-only stand-in that draws a Timeline Clip proxy's Outline representation. */
export const TIMELINE_PROXY_OUTLINE_CLASS_ID = "TimelineProxyOutlineComponent";

export type TimelineProxyOutlineSize = [number, number, number];

/** An Outline component's size (edge lengths along X, Y and Z; one number for all three), `#rrggbb` colour and 2D flag. */
export function timelineProxyOutlineOptions(properties: Record<string, unknown>): { size: TimelineProxyOutlineSize; color: string; twoD: boolean } {
  const edge = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 1);
  const { size } = properties;
  return {
    size: Array.isArray(size) && size.length === 3 ? [edge(size[0]), edge(size[1]), edge(size[2])] : [edge(size), edge(size), edge(size)],
    color: typeof properties.color === "string" ? properties.color : "",
    twoD: properties.twoD === true,
  };
}

/**
 * A Timeline Clip proxy's Outline: a pickable invisible fill of `size` with a
 * dashed edge in the proxy's colour, a box in 3D or a rectangle in 2D. The
 * size is baked into the geometry so the dashes keep their thickness.
 */
export function createTimelineProxyOutlineMesh(
  scene: Scene,
  name: string,
  options: { size: number | TimelineProxyOutlineSize; color: string; twoD: boolean },
): Mesh {
  const edges = typeof options.size === "number" ? [options.size, options.size, options.size] : options.size;
  const [width, height, depth] = edges.map((edge) => Math.max(0.01, Math.abs(edge))) as TimelineProxyOutlineSize;
  const fill = options.twoD
    ? MeshBuilder.CreatePlane(name, { width, height }, scene)
    : MeshBuilder.CreateBox(name, { width, height, depth }, scene);
  fill.metadata = { ...(fill.metadata ?? {}), editorVolume: true };
  fill.isPickable = true;
  fill.renderingGroupId = RENDERING_GROUP.world;
  applyVolumeFillMaterial(fill);
  const half = { x: width / 2, y: height / 2, z: depth / 2 };
  const color = /^#[0-9a-f]{6}$/i.test(options.color) ? Color3.FromHexString(options.color) : COLLIDER_COLOR;
  const outline = createColliderVisualMesh(
    scene,
    `${name}:outline`,
    options.twoD ? { kind: "box2d", halfExtents: { x: half.x, y: half.y } } : { kind: "box", halfExtents: half },
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
