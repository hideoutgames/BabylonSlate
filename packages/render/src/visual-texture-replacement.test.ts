import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, Scene, StandardMaterial, TransformNode } from "@babylonjs/core";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import { createActor, createDefaultScene, createSkyboxComponent, emptySkyboxFaces } from "@babylonslate/core";
import { EditorSceneSync } from "./editor-scene-sync";
import { installTextureBytes, type MeshAssetContext } from "./mesh-assets";
import { ResourceCache } from "./resource-cache";
import { applyAssignMesh, createSnapshotSceneBinding, disposeSnapshotBinding, retirePlaySlot } from "./snapshot-apply";

type Host = "play" | "editor";
type Kind = "skybox" | "sprite";
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => vi.restoreAllMocks());

function fixture(host: Host, kind: Kind) {
  const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 4,
    deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  // Retain real Babylon wrappers/materials and cache leases; NullEngine has no cube IO.
  vi.spyOn(engine, "createCubeTexture").mockImplementation((url, _scene, _files, noMipmap) => {
    const internal = engine.createTexture(url, noMipmap ?? false, false, null);
    internal.isCube = true;
    return internal;
  });
  const cache = new ResourceCache();
  const gates = Array.from({ length: 4 }, deferred);
  gates[0]!.resolve();
  let generation = 0;
  let acquisitions = 0;
  const nativeLoads: Array<Promise<void> | undefined> = [];
  const texture = cache.acquireTexture.bind(cache);
  const cube = cache.acquireCubeTextureFromImages.bind(cache);
  vi.spyOn(cache, "acquireTexture").mockImplementation((...args) => {
    acquisitions++;
    const lease = texture(...args);
    nativeLoads.push(lease.ready);
    return { ...lease, ready: Promise.all([lease.ready, gates[generation]!.promise]).then(() => undefined) };
  });
  vi.spyOn(cache, "acquireCubeTextureFromImages").mockImplementation((...args) => {
    acquisitions++;
    const lease = cube(...args);
    nativeLoads.push(lease.ready);
    return { ...lease, ready: Promise.all([lease.ready, gates[generation]!.promise]).then(() => undefined) };
  });
  const sprites = new Map(gates.map((_, index) => {
    const sprite = createDefaultSpritePayload();
    sprite.textureGuid = `texture-${index}`;
    return [`sprite-${index}`, sprite] as const;
  }));
  const assets: MeshAssetContext = { resourceCache: cache, spritePayloads: sprites,
    textureBytes: installTextureBytes(new Map(gates.map((_, index) => [`texture-${index}`, new Uint8Array([1, 2, index + 1])]))),
  };
  const binding = Object.assign(createSnapshotSceneBinding(), assets);
  binding.liveSlots.add(1);
  const sync = new EditorSceneSync(scene);
  sync.setMeshAssets(assets);
  const document = (index: number) => {
    const component = createSkyboxComponent("visual");
    if (kind === "skybox") component.properties.faces = { ...emptySkyboxFaces(), px: `texture-${index}` };
    else { component.classId = "SpriteComponent"; component.properties = { assetGuid: `sprite-${index}` }; }
    return { ...createDefaultScene(), actors: [createActor("visual", "Visual", { components: [component] })] };
  };
  const assign = (index: number) => {
    generation = index;
    if (host === "editor") sync.apply(document(index));
    else applyAssignMesh(scene, binding, { type: "assignMesh", slotId: 1, meshKind: kind,
      meshAssetGuid: kind === "sprite" ? `sprite-${index}` : null,
      skybox: kind === "skybox" ? { size: 1000, faces: { ...emptySkyboxFaces(), px: `texture-${index}` } } : undefined,
    });
  };
  const current = () => host === "editor" ? sync.meshForActor("visual") : binding.meshes.get(1) ?? null;
  const remove = () => host === "editor" ? sync.apply({ ...createDefaultScene(), actors: [] }) : retirePlaySlot(binding, 1);
  const disposeOwner = () => host === "editor" ? sync.dispose() : disposeSnapshotBinding(binding);
  const cleanup = () => { remove(); sync.dispose(); scene.dispose(); cache.dispose(); engine.dispose(); };
  const ready = async () => { await Promise.allSettled(nativeLoads); await settle(); };
  return { scene, cache, gates, binding, assign, current, remove, disposeOwner, cleanup, ready, acquisitions: () => acquisitions };
}

for (const host of ["play", "editor"] as const) {
  describe(`${host} owned texture hierarchy replacement`, () => {
    it.each(["skybox", "sprite"] as const)("preserves a working %s after preparation fails and latches that request", async (kind) => {
      const f = fixture(host, kind);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        f.assign(0); await f.ready();
        const previous = f.current()!;
        const material = previous.material;
        const overlay = f.binding.spriteOverlays?.get(1);
        const texture = kind === "skybox" ? (material as PBRMaterial).reflectionTexture : (material as StandardMaterial).diffuseTexture;
        const warmed = { meshes: f.scene.meshes.length, materials: f.scene.materials.length, leases: f.cache.resourceStats().leases };
        f.assign(1);
        expect(f.current()).toBe(previous);
        expect(previous.isDisposed()).toBe(false);
        if (host === "play" && kind === "sprite") expect(f.binding.spriteOverlays?.get(1)).toBe(overlay);
        f.gates[1]!.reject(new Error("Controlled texture admission failure"));
        await f.ready(); f.cache.flushUnreferenced();
        expect(f.current()).toBe(previous);
        expect(previous.material).toBe(material);
        expect(texture?.isReady()).toBe(true);
        expect({ meshes: f.scene.meshes.length, materials: f.scene.materials.length, leases: f.cache.resourceStats().leases }).toEqual(warmed);
        const acquired = f.acquisitions();
        f.assign(1); await f.ready();
        expect(f.acquisitions()).toBe(acquired);
      } finally { f.cleanup(); }
    });

    it("retires pending textures immediately when the whole owner is disposed", async () => {
      const f = fixture(host, "sprite");
      try {
        f.assign(0); await f.ready();
        const previous = f.current()!;
        const count = f.scene.meshes.length;
        f.assign(1);
        expect(f.current()).toBe(previous);
        expect(f.scene.meshes.length).toBeGreaterThan(count);
        f.disposeOwner();
        expect(f.scene.meshes).toHaveLength(0);
        expect(f.cache.resourceStats().leases).toBe(0);
        f.gates[1]!.resolve(); await f.ready();
        expect(f.current()).toBeNull();
        expect(f.scene.meshes).toHaveLength(0);
      } finally { f.cleanup(); }
    });

    it.each(["skybox", "sprite"] as const)("keeps the winning %s after stale completion and cannot resurrect a removed owner", async (kind) => {
      const f = fixture(host, kind);
      try {
        f.assign(0); await f.ready();
        const previous = f.current()!;
        const emitter = host === "play" ? new TransformNode("external-emitter", f.scene) : null;
        if (emitter) {
          emitter.parent = previous;
          f.binding.slotVisualReady = (_slot, successor) => { emitter.parent = successor; };
        }
        f.assign(1); f.assign(2);
        expect(f.current()).toBe(previous);
        f.gates[2]!.resolve(); await f.ready();
        const winner = f.current()!;
        expect(winner).not.toBe(previous);
        expect(previous.isDisposed()).toBe(true);
        if (emitter) { expect(emitter.parent).toBe(winner); expect(emitter.isDisposed()).toBe(false); }
        f.gates[1]!.resolve(); await f.ready();
        expect(f.current()).toBe(winner);
        f.assign(3); f.remove();
        expect(winner.isDisposed()).toBe(true);
        f.gates[3]!.resolve(); await f.ready(); f.cache.flushUnreferenced();
        expect(f.current()).toBeNull();
        expect(f.cache.resourceStats().leases).toBe(0);
        expect(f.scene.meshes).toHaveLength(0);
      } finally { f.cleanup(); }
    });
  });
}

it("releases a failed first skybox's material and leases without leaving scene readiness blocked", async () => {
  const f = fixture("play", "skybox");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    f.assign(1);
    const placeholder = f.current()!;
    const material = placeholder.material!;
    f.gates[1]!.reject(new Error("Controlled first upload failure"));
    await f.ready(); f.cache.flushUnreferenced();
    expect(f.current()).toBe(placeholder);
    expect(placeholder.isEnabled()).toBe(false);
    expect(placeholder.material).toBeNull();
    expect(f.scene.materials).not.toContain(material);
    expect(f.cache.resourceStats().leases).toBe(0);
    expect(warning).toHaveBeenCalledOnce();
  } finally { f.cleanup(); }
});
