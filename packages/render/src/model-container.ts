import "./gltf-loader";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Material } from "@babylonjs/core/Materials/material";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { GLTFLoaderAnimationStartMode } from "@babylonjs/loaders/glTF/glTFFileLoader";
import {
  gltfAnimationClips,
  type GlbBrowseAnimation,
} from "@babylonslate/assets";
import { gltfLoaderExtension, packedGltfBytes } from "./model-mesh";

/**
 * glTF shades a triangle mesh without NORMAL flat. Babylon's own materials derive that from
 * screen derivatives, but surface Materials read the normal attribute, and a missing buffer
 * reads as zero, which lights nothing: the mesh draws black. Indexed meshes are unfolded into
 * faces; unindexed ones already are.
 */
export function addMissingFlatNormals(container: Pick<AssetContainer, "meshes">): void {
  for (const mesh of container.meshes) {
    if (!(mesh instanceof Mesh) || mesh.isVerticesDataPresent(VertexBuffer.NormalKind)) continue;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions || (mesh.material?.fillMode ?? Material.TriangleFillMode) !== Material.TriangleFillMode) continue;
    if (!mesh.isUnIndexed) {
      // Babylon flattens a normal buffer it finds, and unfolds the skin and morph streams in step.
      mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(positions.length), false, 3);
      mesh.convertToFlatShadedMesh();
      continue;
    }
    const normals = new Float32Array(positions.length);
    for (let at = 0; at + 8 < positions.length; at += 9) {
      const corner = Vector3.FromArray(positions, at);
      const along = Vector3.FromArray(positions, at + 3).subtractInPlace(corner);
      const across = Vector3.FromArray(positions, at + 6).subtractInPlace(corner);
      const normal = Vector3.Cross(along, across).normalize();
      for (let vertex = 0; vertex < 3; vertex++) normal.toArray(normals, at + vertex * 3);
    }
    mesh.setVerticesData(VertexBuffer.NormalKind, normals, false, 3);
  }
}

/** Load the authored model pose. Playback belongs to the caller, never the loader. */
export async function loadModelContainer(
  scene: Scene,
  bytes: Uint8Array,
  name: string,
) {
  let clips: GlbBrowseAnimation[] = [];
  const targetFps = 60;
  const container = await LoadAssetContainerAsync(
    packedGltfBytes(bytes),
    scene,
    {
      pluginExtension: gltfLoaderExtension(bytes),
      name,
      pluginOptions: {
        gltf: {
          animationStartMode: GLTFLoaderAnimationStartMode.NONE,
          targetFps,
          onParsed: (data) => {
            clips = gltfAnimationClips(data.json as Record<string, unknown>);
            const animations =
              (data.json as { animations?: { name?: string }[] }).animations ??
              [];
            for (const [index, animation] of animations.entries())
              animation.name = clips[index]!.name;
          },
        },
      },
    },
  );
  addMissingFlatNormals(container);
  // glTF normalizes groups to frame zero, inserting a leading hold for DCC takes.
  // Keep source keys intact but play/seek only the authored range of each take.
  const byName = new Map(clips.map((clip) => [clip.name, clip]));
  for (const group of container.animationGroups) {
    const clip = byName.get(group.name);
    if (!clip) continue;
    if (clip.durationMs !== undefined) {
      group.from = ((clip.startTimeMs ?? 0) / 1000) * targetFps;
      group.to = group.from + (clip.durationMs / 1000) * targetFps;
    }
  }
  return container;
}

/** Parent every loaded node that has no parent yet under `parent`. */
export function parentContainerRoots(
  parent: Node,
  container: {
    rootNodes?: readonly Node[];
    transformNodes: readonly TransformNode[];
    meshes: readonly AbstractMesh[];
  },
): void {
  const candidates = [
    ...(container.rootNodes ?? []),
    ...container.transformNodes,
    ...container.meshes,
  ];
  const seen = new Set<Node>();
  for (const node of candidates) {
    if (seen.has(node) || node === parent) continue;
    seen.add(node);
    if (!node.parent) node.parent = parent;
  }
}
