import { describe, expect, it } from "vitest";
import type { IndexedAsset } from "@haptic/assets";
import { thumbnailJobsFor } from "./thumbnail-jobs";

function asset(guid: string, type: string, extra: Partial<IndexedAsset["header"]> = {}, placeholder = false): IndexedAsset {
  return {
    path: `assets/${guid}.hasset`,
    rootId: "assets",
    placeholder,
    header: { guid, type, version: 1, payload: {}, chunks: [], dependencies: [], ...extra },
  } as unknown as IndexedAsset;
}

describe("thumbnailJobsFor", () => {
  it("queues every type that has a thumbnail, Textures and tile assets first", async () => {
    const assets = [
      asset("hero", "Model"),
      asset("walk", "Animation"),
      asset("rock", "Material"),
      asset("map", "Tilemap"),
      asset("grass", "Texture"),
      asset("song", "Audio"),
      asset("font", "Font"),
      asset("missing", "Texture", {}, true),
    ];
    const jobs = await thumbnailJobsFor(assets, assets.map((entry) => entry.header.guid), "project-a", undefined, { onlyIfMissing: true });
    expect(jobs.map((job) => [job.guid, job.type])).toEqual([
      ["grass", "Texture"],
      ["map", "Tilemap"],
      ["hero", "Model"],
      ["walk", "Animation"],
      ["rock", "Material"],
    ]);
    expect(jobs.every((job) => job.projectGuid === "project-a" && job.onlyIfMissing)).toBe(true);
    // Textures have no saved revision: the guid is the key, as at import.
    expect(jobs[0]!.cacheKey).toBe("grass");
    // A Material's key carries its saved revision, so a later edit supersedes the job.
    expect(jobs.find((job) => job.guid === "rock")!.cacheKey).toMatch(/^rock\.preview-v1\./);
  });

  it("skips a Class that shows no Prefab and guids outside the list", async () => {
    const jobs = await thumbnailJobsFor([asset("helper", "Class", { parentClass: "Object" })], ["helper", "gone"], "project-a");
    expect(jobs).toEqual([]);
  });
});
