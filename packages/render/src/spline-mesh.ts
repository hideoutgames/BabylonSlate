import { Color3, CreateLines, LinesMesh, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { parseSplineProperties, splineCentreline, type SplineProperties } from "@babylonslate/core";

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
