import { describe, expect, it } from "vitest";
import {
  decodePackedModelAsset,
  encodePackedModelAsset,
  extractPackedModelAsset,
  normalizeModelPayload,
  peekPackedModelPayload,
  remapModelPayloadGuids,
  shouldSlimModelEmbeddedTextures,
} from "./model-payload";

describe("normalizeModelPayload", () => {
  it("drops importer count fields and keeps named filled slots", () => {
    const payload = normalizeModelPayload({
      materialCount: 2,
      textureCount: 3,
      animationCount: 1,
      clipNames: ["Walk", "Idle"],
      materialSlots: [
        { index: 0, name: "HeroMat", materialGuid: "mat-1" },
        { index: 1, materialGuid: "mat-2" },
      ],
    });
    expect(payload).toEqual({
      clipNames: ["Walk", "Idle"],
      materialSlots: [
        { index: 0, name: "HeroMat", materialGuid: "mat-1" },
        { index: 1, name: "Slot 2", materialGuid: "mat-2" },
      ],
      skeletonGuid: null,
      importScale: 1,
    });
    expect("materialCount" in payload).toBe(false);
    expect("textureCount" in payload).toBe(false);
    expect("animationCount" in payload).toBe(false);
  });

  it("coerces empty slot guids to null and ignores non-string clip names", () => {
    const payload = normalizeModelPayload({
      clipNames: ["Idle", 2, null, "Walk"],
      materialSlots: [
        { index: 0, name: "Body", materialGuid: "" },
        { index: 1, name: "Eyes", materialGuid: null },
      ],
    });
    expect(payload.clipNames).toEqual(["Idle", "Walk"]);
    expect(payload.materialSlots.map((slot) => slot.materialGuid)).toEqual([
      null,
      null,
    ]);
  });

  it("preserves filled guids from legacy imports that omitted slot names", () => {
    const payload = normalizeModelPayload({
      materialSlots: [{ index: 0, materialGuid: "legacy-mat" }],
    });
    expect(payload.materialSlots).toEqual([
      { index: 0, name: "Slot 1", materialGuid: "legacy-mat" },
    ]);
  });

  it("rewrites slot material guids through remapModelPayloadGuids", () => {
    const remapped = remapModelPayloadGuids("Model", {
      clipNames: ["Idle"],
      materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-old" }],
    }, new Map([["mat-old", "mat-new"]]));
    expect(remapped.materialSlots).toEqual([
      { index: 0, name: "Body", materialGuid: "mat-new" },
    ]);
    expect(remapped.skeletonGuid).toBeNull();
  });

  it("keeps skeletonGuid and remaps it", () => {
    const payload = normalizeModelPayload({
      clipNames: ["Idle"],
      skeletonGuid: "  skel-1  ",
    });
    expect(payload.skeletonGuid).toBe("skel-1");
    const remapped = remapModelPayloadGuids(
      "Model",
      { ...payload },
      new Map([["skel-1", "skel-2"]]),
    );
    expect(remapped.skeletonGuid).toBe("skel-2");
  });

  it("coerces missing skeletonGuid to null", () => {
    expect(normalizeModelPayload({ clipNames: [] }).skeletonGuid).toBeNull();
  });

  it("treats missing importScale as 1 so legacy models keep authored size", () => {
    expect(normalizeModelPayload({ clipNames: [] }).importScale).toBe(1);
  });

  it("keeps a positive finite importScale", () => {
    expect(normalizeModelPayload({ importScale: 10 }).importScale).toBe(10);
    expect(normalizeModelPayload({ importScale: 2.5 }).importScale).toBe(2.5);
  });

  it("falls back to 1 for non-positive or non-finite importScale", () => {
    expect(normalizeModelPayload({ importScale: 0 }).importScale).toBe(1);
    expect(normalizeModelPayload({ importScale: -3 }).importScale).toBe(1);
    expect(normalizeModelPayload({ importScale: Number.NaN }).importScale).toBe(
      1,
    );
  });
});

describe("packed Model envelope", () => {
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]);

  it("round-trips payload JSON with GLB source bytes", () => {
    const packed = encodePackedModelAsset(
      {
        importScale: 4,
        clipNames: ["Walk"],
        materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
        skeletonGuid: "skel-1",
      },
      glb,
    );
    expect(peekPackedModelPayload(packed)).toEqual({
      importScale: 4,
      clipNames: ["Walk"],
      materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
      skeletonGuid: "skel-1",
    });
    expect(decodePackedModelAsset(packed)).toEqual({
      payload: {
        importScale: 4,
        clipNames: ["Walk"],
        materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
        skeletonGuid: "skel-1",
      },
      source: glb,
    });
  });

  it("treats raw GLB as unenveloped source so old packs stay loadable", () => {
    expect(peekPackedModelPayload(glb)).toBeNull();
    expect(decodePackedModelAsset(glb)).toBeNull();
    expect(extractPackedModelAsset(glb)).toEqual({
      payload: normalizeModelPayload({}),
      source: glb,
    });
  });
});

describe("shouldSlimModelEmbeddedTextures", () => {
  const boundSlots = {
    materialSlots: [
      { index: 0, name: "A", materialGuid: "mat-1" },
      { index: 1, name: "B", materialGuid: "mat-2" },
    ],
  };

  it("is false when a slot has no material guid", () => {
    expect(
      shouldSlimModelEmbeddedTextures({
        materialSlots: [
          { index: 0, name: "A", materialGuid: "mat-1" },
          { index: 1, name: "B", materialGuid: null },
        ],
      }),
    ).toBe(false);
    expect(shouldSlimModelEmbeddedTextures({ materialSlots: [] })).toBe(false);
  });

  it("is false when slots are bound but packed Texture proof is missing", () => {
    expect(shouldSlimModelEmbeddedTextures(boundSlots)).toBe(false);
  });

  it("is false when textures are packed but slot Materials have not compiled", () => {
    expect(
      shouldSlimModelEmbeddedTextures(boundSlots, {
        packedTextureGuids: new Set(["tex-a", "tex-b"]),
        texturesByMaterialGuid: new Map([
          ["mat-1", ["tex-a"]],
          ["mat-2", ["tex-b"]],
        ]),
      }),
    ).toBe(false);
  });

  it("is true only when every slot Material texture guid is packed", () => {
    const packed = {
      packedTextureGuids: new Set(["tex-a", "tex-b"]),
      texturesByMaterialGuid: new Map([
        ["mat-1", ["tex-a"]],
        ["mat-2", ["tex-b"]],
      ]),
      compiledMaterialGuids: new Set(["mat-1", "mat-2"]),
    };
    expect(shouldSlimModelEmbeddedTextures(boundSlots, packed)).toBe(true);
    expect(
      shouldSlimModelEmbeddedTextures(boundSlots, {
        packedTextureGuids: new Set(["tex-a"]),
        texturesByMaterialGuid: packed.texturesByMaterialGuid,
        compiledMaterialGuids: packed.compiledMaterialGuids,
      }),
    ).toBe(false);
    expect(
      shouldSlimModelEmbeddedTextures(boundSlots, {
        packedTextureGuids: packed.packedTextureGuids,
        texturesByMaterialGuid: new Map([["mat-1", ["tex-a"]]]),
        compiledMaterialGuids: packed.compiledMaterialGuids,
      }),
    ).toBe(false);
  });

  it("is true when known slot Materials reference no textures", () => {
    expect(
      shouldSlimModelEmbeddedTextures(boundSlots, {
        packedTextureGuids: new Set(),
        texturesByMaterialGuid: new Map([
          ["mat-1", []],
          ["mat-2", []],
        ]),
        compiledMaterialGuids: new Set(["mat-1", "mat-2"]),
      }),
    ).toBe(true);
  });
});
