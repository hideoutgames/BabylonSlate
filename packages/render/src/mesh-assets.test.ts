import { afterEach, describe, expect, it } from "vitest";
import { Material, Mesh, StandardMaterial, Texture } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  applyAlbedoTexture,
  applyTilemapAlbedoTextures,
  meshAssetFingerprint,
  modelSlotFingerprint,
} from "./mesh-assets";
import { ResourceCache } from "./resource-cache";

describe("meshAssetFingerprint", () => {
  it("is empty when assets are missing or maps are empty", () => {
    expect(meshAssetFingerprint(undefined)).toBe("");
    expect(meshAssetFingerprint({})).toBe(
      "ppu:|sprites:|spriteAnims:|tilemaps:|tilesets:|tex:|models:",
    );
    expect(
      meshAssetFingerprint({
        textureBytes: new Map(),
        spritePayloads: new Map(),
        spriteAnimations: new Map(),
      }),
    ).toBe("ppu:|sprites:|spriteAnims:|tilemaps:|tilesets:|tex:|models:");
  });

  it("ignores Map identity and treats Blob size like Uint8Array length", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const a = meshAssetFingerprint({
      pixelsPerUnit: 16,
      textureBytes: new Map([["tex-1", bytes]]),
      spriteAnimations: new Map([["anim-1", {} as never]]),
    });
    const b = meshAssetFingerprint({
      pixelsPerUnit: 16,
      textureBytes: new Map([["tex-1", new Blob([bytes])]]),
      spriteAnimations: new Map([["anim-1", {} as never]]),
    });
    expect(a).toBe(b);
    expect(a).toContain("ppu:16");
    expect(a).toContain("tex:tex-1:4");
    expect(a).toContain("spriteAnims:anim-1");
  });

  it("changes when a Sprite Animation guid appears without touching texture bytes", () => {
    const textureBytes = new Map([["tex-1", new Uint8Array([1, 2, 3, 4])]]);
    const before = meshAssetFingerprint({ textureBytes });
    const after = meshAssetFingerprint({
      textureBytes,
      spriteAnimations: new Map([["clip-1", {} as never]]),
    });
    expect(after).not.toBe(before);
  });

  it("does not include Model material slots so a slot edit is not a mesh rebuild", () => {
    const modelBytes = new Map([["model-1", new Uint8Array([9, 9, 9])]]);
    const withEmptySlots = meshAssetFingerprint({
      modelBytes,
      modelPayloads: new Map([
        [
          "model-1",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [],
          },
        ],
      ]),
    });
    const withFilledSlots = meshAssetFingerprint({
      modelBytes,
      modelPayloads: new Map([
        [
          "model-1",
          {
            clipNames: [],
            skeletonGuid: "skel-1",
            materialSlots: [
              { index: 0, name: "Body", materialGuid: "mat-1" },
            ],
          },
        ],
      ]),
    });
    expect(withEmptySlots).toBe(withFilledSlots);
  });
});

describe("modelSlotFingerprint", () => {
  it("is empty when payloads are missing", () => {
    expect(modelSlotFingerprint(undefined)).toBe("");
    expect(modelSlotFingerprint(new Map())).toBe("");
  });

  it("changes when a slot material guid changes and is independent of Map order", () => {
    const a = modelSlotFingerprint(
      new Map([
        [
          "b-model",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [{ index: 0, name: "A", materialGuid: "mat-a" }],
          },
        ],
        [
          "a-model",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [{ index: 1, name: "B", materialGuid: null }],
          },
        ],
      ]),
    );
    const b = modelSlotFingerprint(
      new Map([
        [
          "a-model",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [{ index: 1, name: "B", materialGuid: null }],
          },
        ],
        [
          "b-model",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [{ index: 0, name: "A", materialGuid: "mat-a" }],
          },
        ],
      ]),
    );
    expect(a).toBe(b);
    expect(a).toContain("a-model:1=");
    expect(a).toContain("b-model:0=mat-a");

    const changed = modelSlotFingerprint(
      new Map([
        [
          "b-model",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [{ index: 0, name: "A", materialGuid: "mat-b" }],
          },
        ],
        [
          "a-model",
          {
            clipNames: [],
            skeletonGuid: null,
            materialSlots: [{ index: 1, name: "B", materialGuid: null }],
          },
        ],
      ]),
    );
    expect(changed).not.toBe(a);
  });
});

describe("applyAlbedoTexture", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("no-ops without a guid, cache, or matching bytes", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = new Mesh("quad", handle.scene);
    const before = mesh.material;
    applyAlbedoTexture(mesh, handle.scene, null);
    applyAlbedoTexture(mesh, handle.scene, "tex-1", {
      textureBytes: new Map([["tex-1", new Uint8Array([1, 2, 3, 4])]]),
    });
    applyAlbedoTexture(mesh, handle.scene, "tex-1", {
      resourceCache: new ResourceCache(),
      textureBytes: new Map([["other", new Uint8Array([1, 2, 3, 4])]]),
    });
    expect(mesh.material).toBe(before);
  });

  it("binds a nearest, unlit, alpha-tested albedo from ResourceCache", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const mesh = new Mesh("quad", handle.scene);
    const cache = new ResourceCache();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    applyAlbedoTexture(mesh, handle.scene, "tex-1", {
      resourceCache: cache,
      textureBytes: new Map([["tex-1", bytes]]),
    });
    expect(mesh.material).toBeInstanceOf(StandardMaterial);
    const material = mesh.material as StandardMaterial;
    expect(material.disableLighting).toBe(true);
    expect(material.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
    expect(material.alphaCutOff).toBeCloseTo(0.4);
    expect(material.diffuseTexture).toBeInstanceOf(Texture);
    expect(material.emissiveTexture).toBe(material.diffuseTexture);
    expect(material.diffuseTexture?.hasAlpha).toBe(true);
    cache.dispose();
  });

  it("applies each tilemap child atlas guid and skips children without one", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const root = new Mesh("tilemap", handle.scene);
    const painted = new Mesh("chunk-0", handle.scene);
    painted.parent = root;
    painted.metadata = { tilemapTextureGuid: "atlas-1" };
    const empty = new Mesh("chunk-1", handle.scene);
    empty.parent = root;
    empty.metadata = { tilemapTextureGuid: null };
    const cache = new ResourceCache();
    applyTilemapAlbedoTextures(root, handle.scene, {
      resourceCache: cache,
      textureBytes: new Map([["atlas-1", new Uint8Array([9, 9, 9, 9])]]),
    });
    expect(painted.material).toBeInstanceOf(StandardMaterial);
    expect(empty.material).toBeNull();
    cache.dispose();
  });
});
