import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { parseDecalProperties, type DecalProperties } from "@haptic/core";
import { RENDERING_GROUP } from "./sorting";
import { applyVolumeFillMaterial } from "./editor-volume";

function decalOutlineLines(decal: DecalProperties): Vector3[][] {
  const [hx, hy, hz] = decal.size.map((dimension) => dimension / 2) as [number, number, number];
  const corners = [
    new Vector3(-hx, -hy, -hz), new Vector3(hx, -hy, -hz),
    new Vector3(hx, -hy, hz), new Vector3(-hx, -hy, hz),
    new Vector3(-hx, hy, -hz), new Vector3(hx, hy, -hz),
    new Vector3(hx, hy, hz), new Vector3(-hx, hy, hz),
  ];
  const arrowLen = Math.min(Math.max(hy * 0.85, 0.25), 1.5);
  const head = arrowLen * 0.28;
  return [
    // OBB wireframe box
    ...[
      [0, 1, 2, 3, 0],
      [4, 5, 6, 7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ].map((indices) => indices.map((index) => corners[index]!)),
    // Projection direction arrow along -Y (projector points downward onto surfaces facing +Y)
    [new Vector3(0, hy * 0.5, 0), new Vector3(0, hy * 0.5 - arrowLen, 0)],
    [new Vector3(-head, hy * 0.5 - arrowLen + head, 0), new Vector3(0, hy * 0.5 - arrowLen, 0), new Vector3(head, hy * 0.5 - arrowLen + head, 0)],
    [new Vector3(0, hy * 0.5 - arrowLen + head, -head), new Vector3(0, hy * 0.5 - arrowLen, 0), new Vector3(0, hy * 0.5 - arrowLen + head, head)],
  ];
}

/** Editor-only wireframe OBB + -Y projection arrow with an invisible pick target. */
export function createDecalGuide(scene: Scene, name: string, properties: unknown): Mesh {
  const decal = parseDecalProperties(properties);
  const [width, height, depth] = decal.size;
  const guide = CreateBox(name, { width, height, depth }, scene);
  guide.visibility = 1;
  applyVolumeFillMaterial(guide);
  guide.isPickable = true;
  guide.metadata = { editorVolume: true, decalGuide: true };
  const outline = CreateLineSystem(`${name}:outline`, { lines: decalOutlineLines(decal) }, scene);
  outline.color = new Color3(0.45, 0.85, 0.65);
  outline.isPickable = false;
  outline.applyFog = false;
  outline.parent = guide;
  outline.renderingGroupId = RENDERING_GROUP.world;
  outline.metadata = { editorVolume: true, editorUnpickable: true };
  return guide;
}
