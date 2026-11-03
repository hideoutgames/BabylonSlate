import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { parseSplineProperties, splineCentreline, type SplineProperties } from "@haptic/core";

const bodies = new WeakMap<Mesh, SplineProperties>();
const COLOR = new Color3(0.42, 0.78, 1);

/** Editor-only authoring curve; SplineComponent creates no Play geometry. */
export function createSplineMesh(scene: Scene, name: string, input: unknown): LinesMesh {
  const body = parseSplineProperties(input);
  const mesh = CreateLines(name, { points: splineCentreline(body).map((point) => Vector3.FromArray(point)), updatable: true }, scene);
  mesh.color = COLOR.clone();
  mesh.intersectionThreshold = 0.15;
  mesh.metadata = { editorVolume: true, slateSpline: true };
  bodies.set(mesh, body);
  return mesh;
}

export function splineMeshBody(mesh: Mesh): SplineProperties | null { return bodies.get(mesh) ?? null; }

/** Replace buffers when insertion/removal changes the sample count, retaining the component transform. */
export function updateSplineMeshBody(mesh: Mesh, input: unknown): void {
  if (!(mesh instanceof LinesMesh) || !bodies.has(mesh)) return;
  const body = parseSplineProperties(input);
  const replacement = createSplineMesh(mesh.getScene(), `${mesh.name}:update`, body);
  replacement.geometry?.applyToMesh(mesh);
  replacement.dispose(false, true);
  bodies.set(mesh, body);
}
