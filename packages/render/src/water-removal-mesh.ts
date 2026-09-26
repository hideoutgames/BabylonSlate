import {
  Color3,
  CreateBox,
  CreateLineSystem,
  Mesh,
  StandardMaterial,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import { normalizeWaterRemoval, type WaterRemovalProperties } from "@babylonslate/core";
import { RENDERING_GROUP } from "./sorting";

export const WATER_REMOVAL_COLOR = new Color3(0.25, 0.85, 1);
const removals = new WeakMap<Scene, Set<Mesh>>();

/** Shape code, then half extents, as uploaded to water materials. */
export function waterRemovalShapeVector(volume: WaterRemovalProperties): [number, number, number, number] {
  const code = { box: 1, sphere: 2, cylinder: 3, capsule: 4 }[volume.shape];
  return [code, volume.width / 2, volume.height / 2, volume.length / 2];
}

/** Enabled removal volumes in a scene, with their live world matrices. */
export function sceneWaterRemovals(scene: Scene): Array<{ mesh: Mesh; volume: WaterRemovalProperties }> {
  const result: Array<{ mesh: Mesh; volume: WaterRemovalProperties }> = [];
  for (const mesh of removals.get(scene) ?? []) {
    const volume = (mesh.metadata as { slateWaterRemoval?: WaterRemovalProperties } | null)?.slateWaterRemoval;
    if (volume?.enabled && mesh.isEnabled(false)) result.push({ mesh, volume });
  }
  return result;
}

function circle(axis: "x" | "y" | "z", radius: number, offset = 0, segments = 48): Vector3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = i / segments * Math.PI * 2, u = Math.cos(a) * radius, v = Math.sin(a) * radius;
    return axis === "y" ? new Vector3(u, offset, v) : axis === "x" ? new Vector3(offset, u, v) : new Vector3(u, v, offset);
  });
}

/** Local outline polylines of the primitive, for the editor viewport. */
export function waterRemovalOutline(volume: WaterRemovalProperties): Vector3[][] {
  const w = volume.width / 2, h = volume.height / 2, l = volume.length / 2;
  if (volume.shape === "sphere") return [circle("x", w), circle("y", w), circle("z", w)];
  if (volume.shape === "cylinder" || volume.shape === "capsule") {
    const straight = volume.shape === "capsule" ? Math.max(0, h - w) : h;
    const lines = [circle("y", w, straight), circle("y", w, -straight)];
    for (const [x, z] of [[w, 0], [-w, 0], [0, w], [0, -w]] as const) lines.push([new Vector3(x, -straight, z), new Vector3(x, straight, z)]);
    if (volume.shape === "capsule") {
      // Half-circle caps in the X/Y and Z/Y planes.
      for (const sign of [1, -1]) for (const plane of ["x", "z"] as const) {
        lines.push(Array.from({ length: 25 }, (_, i) => {
          const a = i / 24 * Math.PI, u = Math.cos(a) * w, v = Math.sin(a) * w * sign + straight * sign;
          return plane === "x" ? new Vector3(u, v, 0) : new Vector3(0, v, u);
        }));
      }
    }
    return lines;
  }
  const c = [[-w, -h, -l], [w, -h, -l], [w, -h, l], [-w, -h, l], [-w, h, -l], [w, h, -l], [w, h, l], [-w, h, l]].map(([x, y, z]) => new Vector3(x, y, z));
  return [[c[0]!, c[1]!, c[2]!, c[3]!, c[0]!], [c[4]!, c[5]!, c[6]!, c[7]!, c[4]!], [c[0]!, c[4]!], [c[1]!, c[5]!], [c[2]!, c[6]!], [c[3]!, c[7]!]];
}

/**
 * Water Removal Volume carrier. The editor shows a pickable primitive outline; Play keeps an
 * invisible mesh so water materials still find the volume and its transform.
 */
export function createWaterRemovalMesh(scene: Scene, name: string, properties: unknown, options: { editor: boolean }): Mesh {
  const volume = normalizeWaterRemoval(properties);
  const mesh = new Mesh(name, scene);
  mesh.metadata = { ...(mesh.metadata ?? {}), slateWaterRemoval: volume };
  mesh.isPickable = false;
  if (options.editor) {
    const outline = CreateLineSystem(`${name}:outline`, { lines: waterRemovalOutline(volume) }, scene);
    outline.color = WATER_REMOVAL_COLOR;
    outline.isPickable = false;
    outline.parent = mesh;
    outline.renderingGroupId = RENDERING_GROUP.world;
    outline.metadata = { editorVolume: true };
    // Invisible pick target sized to the primitive's bounds.
    const pick = CreateBox(`${name}:pick`, { width: volume.width, height: volume.height, depth: volume.shape === "box" ? volume.length : volume.width }, scene);
    const material = new StandardMaterial(`${name}:pick`, scene);
    material.alpha = 0; material.disableLighting = true;
    pick.material = material;
    pick.parent = mesh;
    pick.isPickable = true;
    pick.metadata = { editorVolume: true };
    pick.onDisposeObservable.addOnce(() => material.dispose());
  }
  let set = removals.get(scene);
  if (!set) { set = new Set(); removals.set(scene, set); }
  set.add(mesh);
  mesh.onDisposeObservable.addOnce(() => set!.delete(mesh));
  return mesh;
}

/** World-space bounding radius of a removal volume, for choosing which ones reach a water surface. */
export function waterRemovalWorldRadius(mesh: Mesh, volume: WaterRemovalProperties): number {
  const m = mesh.getWorldMatrix().m;
  const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
  return Math.hypot(volume.width, volume.height, volume.shape === "box" ? volume.length : volume.width) / 2 * scale;
}

