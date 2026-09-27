import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { parseFogVolumeProperties, type FogVolumeBinding, type FogVolumeProperties } from "@babylonslate/core";
import { RENDERING_GROUP } from "./sorting";
import { volumeFillMaterial } from "./editor-volume";

const ancestorsByGuide = new WeakMap<Mesh, TransformNode[]>();

function outlineLines(volume: FogVolumeProperties): Vector3[][] {
  const [x, y, z] = volume.size.map((size) => size / 2) as [number, number, number];
  if (volume.shape === "sphere") {
    return [0, 1, 2].map((axis) => Array.from({ length: 33 }, (_, index) => {
      const angle = index / 32 * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      return axis === 0 ? new Vector3(0, y * c, z * s)
        : axis === 1 ? new Vector3(x * c, 0, z * s)
          : new Vector3(x * c, y * s, 0);
    }));
  }
  const corners = [
    new Vector3(-x, -y, -z), new Vector3(x, -y, -z),
    new Vector3(x, -y, z), new Vector3(-x, -y, z),
    new Vector3(-x, y, -z), new Vector3(x, y, -z),
    new Vector3(x, y, z), new Vector3(-x, y, z),
  ];
  return [[0, 1, 2, 3, 0], [4, 5, 6, 7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
    .map((indices) => indices.map((index) => corners[index]!));
}

/** Editor-only wire guide with an invisible, shape-matched pick target. */
export function createFogVolumeGuide(scene: Scene, name: string, properties: unknown): Mesh {
  const volume = parseFogVolumeProperties(properties);
  const [width, height, depth] = volume.size;
  const guide = volume.shape === "sphere"
    ? CreateSphere(name, { diameterX: width, diameterY: height, diameterZ: depth, segments: 12 }, scene)
    : CreateBox(name, { width, height, depth }, scene);
  guide.visibility = 1;
  guide.material = volumeFillMaterial(scene);
  guide.isPickable = true;
  guide.metadata = { editorVolume: true, fogVolumeGuide: true };
  const outline = CreateLineSystem(`${name}:outline`, { lines: outlineLines(volume) }, scene);
  outline.color = new Color3(0.65, 0.8, 0.9);
  outline.isPickable = false;
  outline.applyFog = false;
  outline.parent = guide;
  outline.renderingGroupId = RENDERING_GROUP.world;
  outline.metadata = { editorVolume: true, editorUnpickable: true };
  guide.onDisposeObservable.addOnce(() => {
    for (const ancestor of ancestorsByGuide.get(guide) ?? []) ancestor.dispose(true);
    ancestorsByGuide.delete(guide);
  });
  return guide;
}

/** Keep the guide's editable local TRS separate from its complete component-parent chain. */
export function syncFogVolumeGuideAttachments(
  guide: Mesh,
  actorRoot: Mesh,
  binding: FogVolumeBinding,
  visible: boolean,
): void {
  guide.setEnabled(visible && !binding.error);
  const transforms = binding.transforms.slice(1);
  let ancestors = ancestorsByGuide.get(guide);
  if (!ancestors || ancestors.length !== transforms.length) {
    guide.parent = actorRoot;
    for (const ancestor of ancestors ?? []) ancestor.dispose(true);
    ancestors = transforms.map((_, index) => new TransformNode(`${guide.name}:attachment-${index}`, guide.getScene()));
    ancestorsByGuide.set(guide, ancestors);
  }
  let parent: TransformNode = actorRoot;
  for (let index = transforms.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index]!;
    const transform = transforms[index]!;
    node.parent = parent;
    node.position.fromArray(transform.position);
    node.scaling.fromArray(transform.scale);
    node.rotationQuaternion ??= Quaternion.Identity();
    node.rotationQuaternion.fromArray(transform.rotation);
    parent = node;
  }
  guide.parent = parent;
}
