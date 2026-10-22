import { afterEach, describe, expect, it, vi } from "vitest";
import { StandardMaterial, TextureBlock, type NodeMaterial, type Texture } from "@babylonjs/core";
import { createDefaultSpritePayload } from "@haptic/assets";
import { createActor, createDefaultScene, createMeshComponent, type SerializedScene } from "@haptic/core";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { MaterialLibrary } from "./material-library";
import { installTextureBytes, type MeshAssetContext } from "./mesh-assets";
import { acquireMaterialTexture, ResourceCache } from "./resource-cache";
import { sampledTextureDocument } from "./sampled-texture-material-fixture";
import { onSceneReadinessDirty } from "./scene-readiness-signal";
import { ktx2HeaderBytes } from "./texture-test-fixtures";

// The same pixels stored two ways. A real KTX2 header makes the cache flip the
// wrapper's V axis (a sprite-sampled KTX2 gets a non-identity texture matrix).
const STORED_AS_PNG = new Uint8Array([1, 2, 3, 4]);
const STORED_AS_KTX2 = ktx2HeaderBytes(4, 4);
const STORED_AS_OTHER_PNG = new Uint8Array([1, 2, 3, 4, 5]);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

function host() {
  const handle = createTestEngine();
  cleanups.push(() => { handle.scene.dispose(); handle.engine.dispose(); });
  return handle;
}

function sceneWith(actors: SerializedScene["actors"]): SerializedScene {
  return { ...createDefaultScene(), actors };
}

function installed(bytes: Uint8Array) {
  return installTextureBytes(new Map([["tex", bytes]]))!;
}

function deferred() {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_, no) => { reject = no; });
  return { promise, reject };
}

async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function spriteFixture() {
  const { scene } = host();
  const cache = new ResourceCache();
  cleanups.push(() => cache.dispose());
  const sprite = createDefaultSpritePayload();
  sprite.textureGuid = "tex";
  const assets: MeshAssetContext = {
    resourceCache: cache,
    spritePayloads: new Map([["sprite", sprite]]),
    textureBytes: installed(STORED_AS_PNG),
  };
  const sync = new EditorSceneSync(scene);
  cleanups.push(() => sync.dispose());
  sync.setMeshAssets(assets);
  sync.apply(sceneWith([createActor("a", "A", { components: [{
    id: "visual", classId: "SpriteComponent", properties: { assetGuid: "sprite" },
  }] })]));
  const mesh = sync.meshForActor("a")!;
  const material = mesh.material as StandardMaterial;
  return { scene, cache, assets, sync, mesh, material, first: material.diffuseTexture! };
}

describe("swapping a Texture's stored encoding", () => {
  it("keeps the sprite mesh and material, binds the new upload and releases the old one", async () => {
    const f = spriteFixture();
    expect(f.first).toBeTruthy();
    const meshes = f.scene.meshes.length;
    const swapped = installed(STORED_AS_KTX2);

    f.sync.replaceTextureEncodings(swapped, ["tex"]);

    await vi.waitFor(() => expect(f.material.diffuseTexture).not.toBe(f.first));
    expect(f.sync.meshForActor("a")).toBe(f.mesh);
    expect(f.mesh.isDisposed()).toBe(false);
    expect(f.mesh.material).toBe(f.material);
    expect(f.material.emissiveTexture).toBe(f.material.diffuseTexture);
    expect(f.scene.meshes).toHaveLength(meshes);
    f.cache.flushUnreferenced();
    expect(f.cache.resourceStats().leases).toBe(1);
    // The swap is the new baseline, so an install carrying the same bytes rebuilds nothing.
    expect(f.sync.setMeshAssets({ ...f.assets, textureBytes: swapped })).toBe(false);
    expect(f.sync.meshForActor("a")).toBe(f.mesh);
  });

  it("announces the shader variant change when a KTX2 replaces a PNG, so the visual is held rather than skipped", async () => {
    const f = spriteFixture();
    const dirty = vi.fn();
    cleanups.push(onSceneReadinessDirty(f.scene, dirty));
    // Babylon reads a texture with an identity matrix straight from the UVs and any other through the matrix.
    expect((f.first as Texture).getTextureMatrix().isIdentityAs3x2()).toBe(true);

    f.sync.replaceTextureEncodings(installed(STORED_AS_KTX2), ["tex"]);
    // The working texture stays bound, and nothing is announced, until the successor is ready.
    expect(dirty).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.material.diffuseTexture).not.toBe(f.first));

    expect((f.material.diffuseTexture as Texture).getTextureMatrix().isIdentityAs3x2()).toBe(false);
    expect(dirty).toHaveBeenCalled();
  });

  it("does not announce a swap that keeps the shader variant", async () => {
    const f = spriteFixture();
    const dirty = vi.fn();
    cleanups.push(onSceneReadinessDirty(f.scene, dirty));

    f.sync.replaceTextureEncodings(installed(STORED_AS_OTHER_PNG), ["tex"]);
    await vi.waitFor(() => expect(f.material.diffuseTexture).not.toBe(f.first));

    expect(dirty).not.toHaveBeenCalled();
  });

  it("leaves the working texture bound when the replacement upload fails", async () => {
    const f = spriteFixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = deferred();
    const acquire = f.cache.acquireTexture.bind(f.cache);
    vi.spyOn(f.cache, "acquireTexture").mockImplementation((...args) => {
      const lease = acquire(...args);
      return { ...lease, ready: Promise.all([lease.ready, gate.promise]).then(() => undefined) };
    });

    f.sync.replaceTextureEncodings(installed(STORED_AS_KTX2), ["tex"]);
    expect(f.material.diffuseTexture).toBe(f.first);
    gate.reject(new Error("Controlled texture admission failure"));
    await settle();

    expect(f.material.diffuseTexture).toBe(f.first);
    expect(f.first.isReady()).toBe(true);
    expect(f.mesh.isDisposed()).toBe(false);
    f.cache.flushUnreferenced();
    expect(f.cache.resourceStats().leases).toBe(1);
  });

  it("promotes a new Material generation on the same mesh when a sampled Texture is swapped", async () => {
    const { scene } = host();
    const cache = new ResourceCache();
    cleanups.push(() => cache.dispose());
    let textures = installed(STORED_AS_PNG);
    const document = sampledTextureDocument("tex");
    const library: MaterialLibrary = new MaterialLibrary({
      acquireTexture: (guid, owner) => acquireMaterialTexture(cache, guid, owner.getEngine(), textures.get(guid)!),
      textureIdentity: (guid) => textures.has(guid) ? assetByteFingerprint(textures.get(guid)!) : undefined,
      onMaterialReady: () => sync.refreshMaterials(),
    });
    cleanups.push(() => library.dispose());
    const sync = new EditorSceneSync(scene, undefined, {
      resolveMaterial: (guid, options) => library.resolve(scene, guid, document, options),
    });
    cleanups.push(() => sync.dispose());
    sync.setMeshAssets({ resourceCache: cache, textureBytes: textures });
    const component = createMeshComponent("c1", "box");
    component.properties.materialGuid = "mat";
    sync.apply(sceneWith([createActor("a", "A", { components: [component] })]));
    const root = sync.meshForActor("a")!;
    const first = root.material as NodeMaterial;
    await vi.waitFor(() => expect(library.isReady(scene, "mat", document)).toBe(true), { timeout: 5000 });
    const sampled = (material: NodeMaterial) => (material.getBlockByName("sample") as TextureBlock).texture;
    const before = sampled(first);
    const meshes = scene.meshes.length;

    textures = installed(STORED_AS_KTX2);
    sync.replaceTextureEncodings(textures, ["tex"]);

    await vi.waitFor(() => expect(root.material).not.toBe(first), { timeout: 5000 });
    const next = root.material as NodeMaterial;
    await vi.waitFor(() => expect(library.isReady(scene, "mat", document)).toBe(true), { timeout: 5000 });
    expect(sampled(next)).toBeTruthy();
    expect(sampled(next)).not.toBe(before);
    expect(sync.meshForActor("a")).toBe(root);
    expect(root.isDisposed()).toBe(false);
    expect(scene.meshes).toHaveLength(meshes);
    expect(scene.materials).not.toContain(first);
  });
});
