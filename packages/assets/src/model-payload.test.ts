import { describe, expect, it } from "vitest";
import {
  decodePackedModelAsset,
  encodePackedModelAsset,
  normalizeModelPayload,
  peekPackedModelPayload,
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
      simpleColliders: [],
      autoLod: true,
      occluder: null,
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

  it("keeps a trimmed skeletonGuid", () => {
    const payload = normalizeModelPayload({
      clipNames: ["Idle"],
      skeletonGuid: "  skel-1  ",
    });
    expect(payload.skeletonGuid).toBe("skel-1");
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

  it("normalizes missing simpleColliders to an empty list so legacy Models keep loading", () => {
    expect(normalizeModelPayload({ clipNames: [] }).simpleColliders).toEqual([]);
  });

  it("enables automatic LOD for legacy Models and keeps an explicit opt-out", () => {
    expect(normalizeModelPayload({ clipNames: [] }).autoLod).toBe(true);
    expect(normalizeModelPayload({ autoLod: false }).autoLod).toBe(false);
  });

  it("keeps authored simple colliders on the payload header", () => {
    const payload = normalizeModelPayload({
      simpleColliders: [
        {
          id: "box-1",
          kind: "box",
          halfExtents: { x: 1, y: 2, z: 3 },
        },
      ],
    });
    expect(payload.simpleColliders).toHaveLength(1);
    expect(payload.simpleColliders[0]).toMatchObject({
      id: "box-1",
      kind: "box",
      halfExtents: { x: 1, y: 2, z: 3 },
    });
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
        autoLod: false,
      },
      glb,
    );
    expect(peekPackedModelPayload(packed)).toEqual({
      importScale: 4,
      clipNames: ["Walk"],
      materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
      skeletonGuid: "skel-1",
      simpleColliders: [],
      autoLod: false,
      occluder: null,
    });
    expect(decodePackedModelAsset(packed)).toEqual({
      payload: {
        importScale: 4,
        clipNames: ["Walk"],
        materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
        skeletonGuid: "skel-1",
        simpleColliders: [],
        autoLod: false,
        occluder: null,
      },
      source: glb,
    });
  });

  it("does not read raw GLB as a packed Model", () => {
    expect(peekPackedModelPayload(glb)).toBeNull();
    expect(decodePackedModelAsset(glb)).toBeNull();
  });
});
