import { afterEach, describe, expect, it, vi } from "vitest";
import { StandardMaterial, TextureBlock, type NodeMaterial } from "@babylonjs/core";
import { createDefaultSpritePayload } from "@babylonslate/assets";
import { createActor, createDefaultScene, createMeshComponent, type SerializedScene } from "@babylonslate/core";
import { createDefaultMaterialDocument, type MaterialDocument } from "@babylonslate/shader-graph";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { MaterialLibrary } from "./material-library";
import { installTextureBytes, type MeshAssetContext } from "./mesh-assets";
import { acquireMaterialTexture, ResourceCache } from "./resource-cache";

// The same pixels stored two ways: the render layer only sees different installed bytes.
const STORED_AS_PNG = new Uint8Array([1, 2, 3, 4]);
const STORED_AS_KTX2 = new Uint8Array([1, 2, 3, 4, 5]);

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

/** A Material whose base color samples `textureGuid` through a block named "sample". */
function sampledTextureDocument(textureGuid: string): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push(
    { id: "texture", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid } },
    { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
    { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.edges.push(
    { id: "texture-sample", sourceNodeId: "texture", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
    { id: "uv-sample", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
    { id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
  );
  return doc;
}
