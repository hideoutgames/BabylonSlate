import { readFileSync } from "node:fs";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { afterEach, describe, expect, it } from "vitest";
import { convertFbxToGlb } from "./fbx-conversion";
import { createModelPreviewScene, loadModelPreviewSource, previewRigRoot } from "./model-preview";
import { RIG_BONE_VERTICES, RIG_JOINT_VERTICES, RIG_SELECTED_COLOR } from "./rig-preview-geometry";
import { attachSkeletonPreview } from "./skeleton-preview";
import { createTestEngine } from "./test-support/test-engine";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

async function preview(bytes: Uint8Array, kind: "skin" | "hierarchy", importScale = 1) {
  const handle = createTestEngine();
  const host = createModelPreviewScene(handle.engine);
  disposers.push(() => {
    host.scene.dispose();
    handle.engine.dispose();
  });
  const loaded = await loadModelPreviewSource(host, bytes, importScale);
  for (const group of loaded!.animationGroups) group.stop();
  const root = previewRigRoot(host);
  const rig = attachSkeletonPreview(root, host.scene, kind);
  const overlay = root.getChildMeshes(true).find((mesh) => mesh.name.endsWith("_skeleton_overlay"))!;
  const lines = root.getChildMeshes(true).find((mesh) => mesh.name.endsWith("_skeleton_lines_overlay"));
  const vertices = () => overlay.getVerticesData(VertexBuffer.PositionKind)!;
  const point = (index: number) => Vector3.FromArray(vertices(), index * 3);
  /** Each line's ends, from the line system the preview draws its lines with. */
  const lineEnds = () => {
    const data = lines?.getVerticesData(VertexBuffer.PositionKind) ?? [];
    return Array.from({ length: data.length / 6 }, (_, line) => [Vector3.FromArray(data, line * 6), Vector3.FromArray(data, line * 6 + 3)]);
  };
  return { host, root, rig, overlay, vertices, point, lineEnds, animationGroups: loaded!.animationGroups };
}

/** The centre of each of the last `count` balls, in draw order. */
function balls(vertices: ArrayLike<number>, count: number): Vector3[] {
  const start = vertices.length / 3 - count * RIG_JOINT_VERTICES;
  return Array.from({ length: count }, (_, ball) => {
    const centre = new Vector3();
    for (let v = 0; v < RIG_JOINT_VERTICES; v++) centre.addInPlace(Vector3.FromArray(vertices, (start + ball * RIG_JOINT_VERTICES + v) * 3));
    return centre.scaleInPlace(1 / RIG_JOINT_VERTICES);
  });
}

/** The skinned vertices weighted wholly to one bone, in the rig root's space, by bone index. */
function rigidVertices(mesh: AbstractMesh, root: TransformNode): Map<number, Vector3[]> {
  const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)!;
  const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!;
  const skinned = mesh.getPositionData(true, false)!;
  const toRoot = mesh.computeWorldMatrix(true).multiply(root.computeWorldMatrix(true).clone().invert());
  const byBone = new Map<number, Vector3[]>();
  for (let v = 0; v < skinned.length / 3; v++) {
    let bone = -1;
    for (let k = 0; k < 4; k++) if (weights[v * 4 + k]! >= 0.999) bone = indices[v * 4 + k]!;
    if (bone < 0) continue;
    const list = byBone.get(bone) ?? [];
    list.push(Vector3.TransformCoordinates(Vector3.FromArray(skinned, v * 3), toRoot));
    byBone.set(bone, list);
  }
  return byBone;
}

const read = (path: string) => new Uint8Array(readFileSync(path));

describe("attachSkeletonPreview", () => {
  it("draws KayKit's rig a bone per joint, and keeps every joint on the skin as it walks", async () => {
    const { root, vertices, point, lineEnds, host, animationGroups } = await preview(read("engine-content/kaykit-assets/Adventurers/Rig_Medium_MovementBasic.glb"), "skin");
    // 23 joints: the root and both hand slots deform nothing (balls alone); 20 bones; lines from the root to the
    // hips, the hips to both thighs, the chest to both upper arms and each hand to its slot.
    expect(vertices().length / 3).toBe(20 * RIG_BONE_VERTICES + 23 * RIG_JOINT_VERTICES);
    expect(lineEnds()).toHaveLength(7);
    const rest = balls(vertices(), 23);
    // The first line runs from the root, on the floor, up to the hips.
    expect(Vector3.Distance(lineEnds()[0]![0]!, rest[0]!)).toBeLessThan(1e-5);
    expect(Vector3.Distance(lineEnds()[0]![1]!, rest[1]!)).toBeLessThan(1e-5);
    // The first bone is the hips' (the root draws none): it runs to the spine.
    expect(Vector3.Distance(point(3), rest[6]!)).toBeLessThan(1e-5);
    expect(Vector3.Distance(point(0), rest[1]!)).toBeLessThan(1e-5);
    // The fifth is the right toes' (no child): its tail runs along the toes' own axis, forward along the ground, half
    // as long as the foot-to-toes bone (16.6 cm).
    const toes = point(4 * RIG_BONE_VERTICES + 3).subtract(point(4 * RIG_BONE_VERTICES));
    expect(Vector3.Distance(point(4 * RIG_BONE_VERTICES), rest[5]!)).toBeLessThan(1e-5);
    expect(toes.length()).toBeCloseTo(0.083, 3);
    expect(Math.abs(toes.z)).toBeGreaterThan(Math.abs(toes.y) * 2);

    // Walking, a vertex weighted wholly to one bone keeps its distance to that bone's drawn joint.
    const mesh = root.getChildMeshes(false).find((candidate) => candidate.skeleton && candidate.getTotalVertices() > 0)!;
    const before = rigidVertices(mesh, root);
    const walk = animationGroups.find((group) => group.name === "Walking_A")!;
    walk.start(false, 1, walk.from, walk.to);
    walk.goToFrame((walk.from + walk.to) / 2);
    walk.pause();
    host.scene.onBeforeRenderObservable.notifyObservers(host.scene);
    const posed = balls(vertices(), 23);
    const after = rigidVertices(mesh, root);
    expect(before.size).toBeGreaterThan(0);
    let moved = 0;
    for (const [bone, points] of before) {
      points.forEach((point, index) => {
        const change = Vector3.Distance(after.get(bone)![index]!, posed[bone]!) - Vector3.Distance(point, rest[bone]!);
        expect(Math.abs(change)).toBeLessThan(1e-4);
      });
      moved = Math.max(moved, Vector3.Distance(rest[bone]!, posed[bone]!));
    }
    expect(moved).toBeGreaterThan(0.05);
  });

  it("leaves out the Velociraptor's armature object and end markers, and selects a marker's bone for it", async () => {
    const raptor = await convertFbxToGlb({ name: "Velociraptor.fbx", bytes: read("engine-content/quaternius-assets/Dinosaurs/Velociraptor.fbx") });
    const { rig, overlay, vertices, lineEnds } = await preview(raptor, "skin", 0.15);
    // 38 joints: the Armature and 8 end markers (both back feet and lower back legs, both front feet, the head and
    // the tail) draw nothing; the Body deforms nothing (a ball alone); 28 bones; lines from the root to the Body and
    // both back feet, and from the Body to its 6 children.
    expect(rig.boneCount).toBe(38);
    expect(vertices().length / 3).toBe(28 * RIG_BONE_VERTICES + 29 * RIG_JOINT_VERTICES);
    expect(lineEnds()).toHaveLength(9);
    const colors = () => overlay.getVerticesData(VertexBuffer.ColorKind)!;
    const selectedFaces = () => {
      let count = 0;
      const data = colors();
      for (let v = 0; v < data.length / 4; v += 3) {
        const [r, g, b] = [data[v * 4]!, data[v * 4 + 1]!, data[v * 4 + 2]!];
        if (r > 0 && Math.abs(g / r - RIG_SELECTED_COLOR[1] / RIG_SELECTED_COLOR[0]) < 0.01 && Math.abs(b / r - RIG_SELECTED_COLOR[2] / RIG_SELECTED_COLOR[0]) < 0.01) count++;
      }
      return count;
    };
    // Picking an end marker lights the Head's bone and ball, which it ends.
    rig.setSelectedBone("Head_end");
    expect(selectedFaces()).toBe((RIG_BONE_VERTICES + RIG_JOINT_VERTICES) / 3);
    rig.setSelectedBone("Armature");
    expect(selectedFaces()).toBe(0);
  });

  it("draws an animation library's joints alike at rest and attached mid-clip", async () => {
    const bytes = read("engine-content/kaykit-assets/Adventurers/Rig_Medium_MovementBasic.glb");
    const counts: number[] = [];
    for (const posed of [false, true]) {
      const handle = createTestEngine();
      const host = createModelPreviewScene(handle.engine);
      disposers.push(() => {
        host.scene.dispose();
        handle.engine.dispose();
      });
      const loaded = await loadModelPreviewSource(host, bytes);
      const root = previewRigRoot(host);
      // No meshes, as an animation-only file: the rig is its nodes, with no weights to tell what deforms.
      // The loader moves a skinned mesh out of its node, which stays behind empty under the mesh's name.
      const removed = new Set<string>();
      for (const mesh of root.getChildMeshes(false)) {
        if (mesh.getTotalVertices() === 0) continue;
        removed.add(mesh.name);
        mesh.dispose(true);
      }
      for (const node of root.getChildTransformNodes(false)) if (removed.has(node.name)) node.dispose(true);
      for (const group of loaded!.animationGroups) group.stop();
      if (posed) {
        const walk = loaded!.animationGroups.find((group) => group.name === "Walking_A")!;
        walk.start(false, 1, walk.from, walk.to);
        walk.goToFrame((walk.from + walk.to) / 2);
        walk.pause();
      }
      attachSkeletonPreview(root, host.scene, "skin");
      const overlay = root.getChildMeshes(true).find((mesh) => mesh.name.endsWith("_skeleton_overlay"))!;
      counts.push(overlay.getTotalVertices());
    }
    // The armature object draws nothing and the root (the top joint) a ball alone; the other 22 joints a bone each,
    // the hand slots too; lines from the root to the hips, the hips to both thighs, the chest to both upper arms and
    // each hand to its slot.
    const rest = 22 * RIG_BONE_VERTICES + 23 * RIG_JOINT_VERTICES;
    expect(counts).toEqual([rest, rest]);
  });

  it("runs each rigid part's bone from its pivot through its part", async () => {
    const { vertices, point, lineEnds } = await preview(read("engine-content/kenney-assets/Mannequin/mannequin.glb"), "hierarchy");
    // The character node is the import's armature object (nothing), the root a ball; six parts draw a bone each,
    // each joined to its parent by a line.
    expect(vertices().length / 3).toBe(6 * RIG_BONE_VERTICES + 7 * RIG_JOINT_VERTICES);
    expect(lineEnds()).toHaveLength(6);
    // The first part is a leg: from its hip pivot at 1 m down to the bottom of the leg, at the floor.
    expect(point(0).y).toBeCloseTo(1, 4);
    expect(point(3).y).toBeCloseTo(0, 4);
  });
});
