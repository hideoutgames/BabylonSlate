import { Mesh, type Material } from "@babylonjs/core";
import type { SerializedComponent } from "@babylonslate/core";
import type { MeshAssetContext } from "./mesh-assets";
import { ownedMaterialPreparation } from "./material-library";
import { applyMaterialBounds } from "./material-bounds";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { isColliderVisualTree } from "./collider-visual";

type Request = {
  key: string;
  signature: string;
  material: Material;
  release: () => void;
};
type Owner = {
  active?: Request;
  pending?: Request;
  preparation?: Promise<void>;
  originals: Map<Mesh, Material | null>;
  apply: (material: Material) => void;
  onPublished?: () => void;
};
const owners = new WeakMap<Mesh, Owner>();
let nextInstance = 0;

/** Exact pending texture/compile admission, consumed by the existing scene-load gate. */
export function authoredMaterialInstancePreparation(mesh: Mesh): Promise<void> | undefined {
  return owners.get(mesh)?.preparation;
}

function release(owner: Owner): void {
  for (const [mesh, material] of owner.originals) {
    if (!mesh.isDisposed() && mesh.material === owner.active?.material) {
      mesh.material = material;
      applyMaterialBounds(mesh);
    }
  }
  owner.pending?.release();
  owner.active?.release();
  owner.pending = undefined;
  owner.active = undefined;
  owner.preparation = undefined;
}

/**
 * Scene-owned persisted overrides. A replacement retains the last valid material
 * until its exact compiler/texture admission succeeds; each visual owns its lease.
 */
export function applyAuthoredMaterialInstance(
  visual: Mesh,
  component: SerializedComponent,
  assets: MeshAssetContext | undefined,
  options: { unlit?: boolean; onPublished?: () => void; apply?: (material: Material) => void } = {},
): void {
  let owner = owners.get(visual);
  const instance = component.materialInstance;
  const guid = component.properties.materialGuid;
  if (!instance || typeof guid !== "string" || instance.materialGuid !== guid || !Object.keys(instance.parameters).length) {
    if (owner) { release(owner); owners.delete(visual); }
    return;
  }
  if (!assets?.resolveMaterial || !assets.releaseMaterialInstance)
    throw new Error("Saved material instances require a scene-owned material resolver and release boundary.");
  const resolve = assets.resolveMaterial;
  const releaseInstance = assets.releaseMaterialInstance;
  const parameters = new Map(Object.entries(instance.parameters).sort(([a], [b]) => a.localeCompare(b)));
  const signature = JSON.stringify([guid, options.unlit === true, [...parameters]]);
  if (!owner) {
    owner = { originals: new Map(), apply: () => {} };
    owners.set(visual, owner);
    const owned = owner;
    visual.onDisposeObservable.addOnce(() => { release(owned); owners.delete(visual); });
  }
  const owned = owner;
  owned.onPublished = options.onPublished;
  const targets = [visual, ...visual.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh)]
    .filter((mesh) => !mesh.isBlocked && !isColliderVisualTree(mesh) &&
      // Attached component/actor roots have independent material ownership.
      (mesh === visual || !mesh.name.startsWith("editorActor:") || mesh.name.startsWith(`${visual.name}:`)));
  const live = new Set(targets);
  for (const target of owned.originals.keys()) if (!live.has(target)) owned.originals.delete(target);
  for (const target of targets) {
    if (target.material !== owned.active?.material && target.material !== owned.pending?.material)
      owned.originals.set(target, target.material);
  }
  owned.apply = options.apply ?? ((material) => {
    for (const target of targets) { target.material = material; applyMaterialBounds(target); }
  });
  if (owned.active?.signature === signature) {
    owned.pending?.release();
    owned.pending = undefined;
    owned.preparation = undefined;
    // Refreshing a changed source graph is still the existing library's job.
    const material = resolve(guid, { scene: visual.getScene(), unlit: options.unlit,
      instanceKey: owned.active.key, parameters });
    if (material) { owned.active.material = material; owned.apply(material); }
    return;
  }
  if (owned.active) owned.apply(owned.active.material);
  if (owned.pending?.signature === signature) return;
  owned.pending?.release();
  owned.pending = undefined;
  const rejected = [...parameters].find(([name, value]) => assets.validateMaterialParameter?.(guid, name, value) === false);
  if (rejected) {
    owned.preparation = Promise.reject(new Error(`Saved material parameter "${rejected[0]}" is not supported by ${guid}.`));
    void owned.preparation.catch(() => {});
    return;
  }
  const key = `authored-material:${++nextInstance}`;
  const material = resolve(guid, { scene: visual.getScene(), unlit: options.unlit, instanceKey: key, parameters });
  if (!material) {
    releaseInstance(key, guid);
    owned.preparation = Promise.reject(new Error(`Saved material instance could not resolve material ${guid}.`));
    void owned.preparation.catch(() => {});
    return;
  }
  const request: Request = { key, signature, material, release: () => releaseInstance(key, guid) };
  owned.pending = request;
  markSceneReadinessDirty(visual.getScene());
  const preparation = (ownedMaterialPreparation(material) ?? Promise.resolve([])).then((diagnostics) => {
    if (owned.pending !== request || visual.isDisposed() || visual.getScene().isDisposed) return;
    if (diagnostics.length) throw new Error(diagnostics.map((entry) => entry.message).join("; "));
    const previous = owned.active;
    owned.active = request;
    owned.pending = undefined;
    owned.preparation = undefined;
    owned.apply(request.material);
    previous?.release();
    markSceneReadinessDirty(visual.getScene());
    owned.onPublished?.();
  }).catch((error: unknown) => {
    if (owned.pending !== request) return;
    owned.pending = undefined;
    request.release();
    throw error;
  });
  owned.preparation = preparation;
  void preparation.catch((error: unknown) => console.warn(`[render] Saved material instance could not load: ${String(error)}`));
}
