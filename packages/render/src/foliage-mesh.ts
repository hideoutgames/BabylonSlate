import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { parseFoliageProperties, type FoliageBatch } from "@babylonslate/core";
import type { MeshAssetContext } from "./mesh-assets";
import { acquireGlbContainer, createModelMaterialCloner, prepareInstanceMaterials } from "./glb-anim";
import { installAssetBytes } from "@babylonslate/assets";
import { applyModelMaterialSlots } from "./model-preview";
import { RENDERING_GROUP } from "./sorting";
import { snapshotByteFingerprint } from "./asset-byte-fingerprint";
import { VisualBundle } from "./visual-bundle";
import { applyMaterialBounds } from "./material-bounds";

const preparations = new WeakMap<Mesh, Promise<void>>();
const batchesByRoot = new WeakMap<Mesh, Array<{ root: Mesh; batch: FoliageBatch }>>();

export function foliagePreparation(root: Mesh): Promise<void> | undefined { return preparations.get(root); }

export function foliageSourceFingerprint(properties: unknown, assets?: MeshAssetContext): string {
  const models = new Set(parseFoliageProperties(properties).batches.map((batch) => batch.modelGuid));
  return [...models].map((guid) => {
    const source = assets?.modelSources?.get(guid) ?? assets?.modelBytes?.get(guid);
    return `${guid}:${source ? snapshotByteFingerprint(source) : "missing"}:${assets?.modelPayloads?.get(guid)?.importScale ?? 1}`;
  }).join("|");
}

export function refreshFoliageMaterials(root: Mesh, assets?: MeshAssetContext): void {
  for (const entry of batchesByRoot.get(root) ?? []) {
    const payload = assets?.modelPayloads?.get(entry.batch.modelGuid);
    const resolve = (guid: string) => assets?.resolveMaterial?.(guid, { scene: root.getScene() }) ?? null;
    applyModelMaterialSlots(entry.root, payload?.materialSlots ?? [], resolve);
    const override = entry.batch.materialGuid ? resolve(entry.batch.materialGuid) : null;
    if (override) for (const mesh of entry.root.getChildMeshes()) {
      mesh.material = override;
      applyMaterialBounds(mesh);
    }
  }
}

/** One thin-instance draw per model primitive/material/spatial cell; never one actor per plant. */
export function createFoliageMesh(scene: Scene, name: string, properties: unknown, assets?: MeshAssetContext): Mesh {
  const data = parseFoliageProperties(properties);
  const root = new Mesh(name, scene);
  root.isPickable = false;
  const bundle = new VisualBundle();
  const { cloneMaterial } = createModelMaterialCloner(scene, bundle);
  const batches: Array<{ root: Mesh; batch: FoliageBatch }> = [];
  batchesByRoot.set(root, batches);
  let cancel!: (reason: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
  void cancellation.catch(() => {});
  root.onDisposeObservable.addOnce(() => {
    cancel(new Error("Foliage preparation cancelled"));
    bundle.dispose();
  });
  const ready = (async () => {
    for (const [batchIndex, batch] of data.batches.entries()) {
      if (root.isDisposed()) return;
      const bytes = assets?.modelBytes?.get(batch.modelGuid);
      const source = assets?.modelSources?.get(batch.modelGuid) ?? (bytes ? installAssetBytes(bytes, "model/gltf-binary") : undefined);
      if (!source) continue;
      const lease = acquireGlbContainer(scene, batch.modelGuid, source);
      bundle.releaseWith(() => lease.release());
      const container = await lease.load;
      if (root.isDisposed()) return;
      const batchRoot = new Mesh(`${name}:batch:${batchIndex}`, scene);
      batchRoot.parent = root;
      batchRoot.setEnabled(false);
      batchRoot.isPickable = false;
      batches.push({ root: batchRoot, batch });
      const scale = assets?.modelPayloads?.get(batch.modelGuid)?.importScale ?? 1;
      const cells = new Map<string, typeof batch.transforms>();
      for (const transform of batch.transforms) {
        const key = `${Math.floor(transform.position[0] / 32)}:${Math.floor(transform.position[2] / 32)}`;
        const cell = cells.get(key) ?? [];
        cell.push(transform); cells.set(key, cell);
      }
      for (const sourceMesh of container.meshes) {
        const geometry = sourceMesh instanceof InstancedMesh ? sourceMesh.sourceMesh : sourceMesh;
        if (!(geometry instanceof Mesh) || !geometry.getTotalVertices()) continue;
        const modelMatrix = sourceMesh.computeWorldMatrix(true).multiply(Matrix.Scaling(scale, scale, scale));
        for (const [cell, transforms] of cells) {
          const mesh = geometry.clone(`${name}:foliage:${batchIndex}:${sourceMesh.uniqueId}:${cell}`, batchRoot, true);
          bundle.ownRenderUser(mesh);
          if (mesh.material) mesh.material = cloneMaterial(mesh.material);
          mesh.position.setAll(0); mesh.rotation.setAll(0); mesh.rotationQuaternion = Quaternion.Identity(); mesh.scaling.setAll(1);
          mesh.skeleton = null; mesh.morphTargetManager = null;
          mesh.setEnabled(true); mesh.isVisible = true; mesh.visibility = 1;
          mesh.renderingGroupId = RENDERING_GROUP.world;
          mesh.receiveShadows = true;
          mesh.isPickable = true;
          mesh.thinInstanceEnablePicking = true;
          mesh.metadata = { foliageRoot: root };
          const matrices = new Float32Array(transforms.length * 16);
          transforms.forEach((transform, i) => {
            modelMatrix.multiply(Matrix.Compose(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation), Vector3.FromArray(transform.position))).copyToArray(matrices, i * 16);
          });
          mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
          mesh.thinInstanceRefreshBoundingInfo(true);
        }
      }
    }
    if (root.isDisposed()) return;
    refreshFoliageMaterials(root, assets);
    await prepareInstanceMaterials(root, () => {
      if (root.isDisposed()) throw new Error("Foliage preparation cancelled");
    }, cancellation);
    if (!root.isDisposed()) for (const entry of batches) entry.root.setEnabled(true);
  })().catch((error: unknown) => {
    // Releasing the last lease during deletion can retire an in-flight decode.
    if (!root.isDisposed()) throw error;
  });
  preparations.set(root, ready);
  void ready.catch(() => {});
  return root;
}
