import { describe, expect, it } from "vitest";
import { groupObjImportSidecars } from "./obj-import-batch";

function file(name: string, text = "x"): { name: string; bytes: Uint8Array } {
  return { name, bytes: new TextEncoder().encode(text) };
}

describe("groupObjImportSidecars", () => {
  it("pairs an OBJ with same-stem MTL and map files and leaves unrelated images", () => {
    const grouped = groupObjImportSidecars([
      file("Hero.obj", "v 0 0 0"),
      file("Hero.mtl", "map_Kd hero-albedo.png"),
      file("hero-albedo.png"),
      file("Hero.png"),
      file("unrelated.png"),
    ]);
    expect(grouped.objs).toHaveLength(1);
    expect(grouped.objs[0]!.obj.name).toBe("Hero.obj");
    expect(grouped.objs[0]!.sidecars.map((entry) => entry.name).sort()).toEqual([
      "Hero.mtl",
      "Hero.png",
      "hero-albedo.png",
    ]);
    expect(grouped.rest.map((entry) => entry.name)).toEqual(["unrelated.png"]);
  });

  it("keeps a lone OBJ with no sidecars", () => {
    const grouped = groupObjImportSidecars([file("crate.obj")]);
    expect(grouped.objs[0]!.sidecars).toEqual([]);
    expect(grouped.rest).toEqual([]);
  });
});
