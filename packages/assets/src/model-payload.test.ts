import { describe, expect, it } from "vitest";
import { normalizeModelPayload, remapModelPayloadGuids } from "./model-payload";

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
});
