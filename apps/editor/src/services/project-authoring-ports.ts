import type { ProjectStorage } from "@babylonslate/core";
import type { AssetRegistry, BlobStore, ContentRoot, EncodeQueue } from "@babylonslate/assets";
import { admitOwnerWrites, guardProjectStorage, type ProjectWriteAdmission } from "./project-write-admission";

/** Guard handles returned to editor utilities without changing internal owners. */
export function guardProjectAssetRegistry(registry: AssetRegistry, admission: ProjectWriteAdmission): AssetRegistry {
  const owner = admitOwnerWrites(registry, admission, [
    "createAsset", "deleteAsset", "deleteFolder", "createFolder", "moveAsset",
    "renameAsset", "duplicateAsset", "copyAsset", "copyFolder", "duplicateFolder",
    "moveFolder", "importFile", "setCompressionState", "commitCompressedTexture",
    "prepareAreaEmission", "retryTextureEncoding", "requeueUncompressedTextures",
    "reconcileTextureAlignment", "withAssetWrite", "mountRoot", "reindexPath",
  ]);
  const storageViews = new WeakMap<ProjectStorage, ProjectStorage>();
  const blobViews = new WeakMap<BlobStore, BlobStore>();
  const rootViews = new WeakMap<ContentRoot, ContentRoot>();
  const storageView = (storage: ProjectStorage) => {
    let view = storageViews.get(storage);
    if (!view) { view = guardProjectStorage(storage, admission); storageViews.set(storage, view); }
    return view;
  };
  const blobView = (blobs: BlobStore) => {
    let view = blobViews.get(blobs);
    if (!view) { view = admitOwnerWrites(blobs, admission, ["writeBlob"]); blobViews.set(blobs, view); }
    return view;
  };
  const rootView = (root: ContentRoot) => {
    if (!root.storage) return root;
    let view = rootViews.get(root);
    if (!view) { view = { ...root, storage: storageView(root.storage) }; rootViews.set(root, view); }
    return view;
  };
  const exposed = {
    unmountRoot: (rootId: string) => { admission.assertAdmission(); registry.unmountRoot(rootId); },
    storageFor: (rootId: string) => storageView(registry.storageFor(rootId)),
    blobsFor: (rootId: string) => blobView(registry.blobsFor(rootId)),
    getRoot: (rootId: string) => { const root = registry.getRoot(rootId); return root ? rootView(root) : undefined; },
    listRoots: () => registry.listRoots().map(rootView),
  };
  return new Proxy(owner, {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(exposed, key)) return Reflect.get(exposed, key);
      return Reflect.get(target, key);
    },
  });
}

/** Public queue access cannot restart a locked project's encoder or add work. */
export function guardProjectEncodeQueue(queue: EncodeQueue, admission: ProjectWriteAdmission): EncodeQueue {
  const owner = admitOwnerWrites(queue, admission, ["enqueueDerived"]);
  return new Proxy(owner, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function" || (key !== "enqueue" && key !== "resume")) return value;
      return (...args: unknown[]) => {
        admission.assertAdmission();
        return Reflect.apply(value, target, args);
      };
    },
  });
}
