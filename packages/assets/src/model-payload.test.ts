import { describe, expect, it } from "vitest";
import {
  effectiveModelClipNames,
  modelSkeletonsCompatible,
  normalizeModelPayload,
  remapModelPayloadGuids,
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
      animationSourceGuid: null,
      boneNames: [],
      clipDurations: [],
      clipNames: ["Walk", "Idle"],
      hasSkin: false,
      materialSlots: [
        { index: 0, name: "HeroMat", materialGuid: "mat-1" },
        { index: 1, name: "Slot 2", materialGuid: "mat-2" },
      ],
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
  });

  it("keeps skin metadata, clip durations, and animation source guid", () => {
    const payload = normalizeModelPayload({
      hasSkin: true,
      boneNames: ["Hips", "Spine", ""],
      clipNames: ["Walk"],
      clipDurations: [1.25, "x"],
      animationSourceGuid: "  anim-lib  ",
    });
    expect(payload.hasSkin).toBe(true);
    expect(payload.boneNames).toEqual(["Hips", "Spine"]);
    expect(payload.clipDurations).toEqual([1.25]);
    expect(payload.animationSourceGuid).toBe("anim-lib");
  });

  it("rewrites animationSourceGuid through remapModelPayloadGuids", () => {
    const remapped = remapModelPayloadGuids(
      "Model",
      {
        clipNames: [],
        animationSourceGuid: "src-old",
      },
      new Map([["src-old", "src-new"]]),
    );
    expect(remapped.animationSourceGuid).toBe("src-new");
  });

  it("treats a skeleton as compatible when every source bone exists on the target", () => {
    expect(
      modelSkeletonsCompatible(["Hips", "Spine"], ["Hips", "Spine", "Head"]),
    ).toBe(true);
    expect(modelSkeletonsCompatible(["Hips", "Tail"], ["Hips", "Spine"])).toBe(
      false,
    );
    expect(modelSkeletonsCompatible([], ["Hips"])).toBe(false);
  });

  it("unions clip names from an animation source Model", () => {
    expect(
      effectiveModelClipNames(
        { clipNames: ["Idle"] },
        { clipNames: ["Walk", "Idle"] },
      ),
    ).toEqual(["Idle", "Walk"]);
    expect(effectiveModelClipNames({ clipNames: ["Idle"] }, null)).toEqual([
      "Idle",
    ]);
  });
});
