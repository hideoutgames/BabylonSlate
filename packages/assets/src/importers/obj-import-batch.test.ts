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

  it("takes map file names after texture options and leaves other same-stem files to import", () => {
    const grouped = groupObjImportSidecars([
      file("Hero.obj", "v 0 0 0"),
      file("Hero.mtl", "map_Kd -s 1 1 1 hero_albedo.png\nbump -bm 0.5 hero_normal.png\nmap_Ks -clamp on -o 0.5 spec.png"),
      file("hero_albedo.png"),
      file("hero_normal.png"),
      file("spec.png"),
      file("Hero.fbx"),
      file("Hero.wav"),
    ]);
    expect(grouped.objs[0]!.sidecars.map((entry) => entry.name).sort()).toEqual([
      "Hero.mtl",
      "hero_albedo.png",
      "hero_normal.png",
      "spec.png",
    ]);
    expect(grouped.rest.map((entry) => entry.name)).toEqual(["Hero.fbx", "Hero.wav"]);
  });

  it("gives each OBJ the MTL and textures of its own folder when a ZIP's folders reuse file names", () => {
    const files = ["Chair", "Table"].flatMap((folder) => [
      file(`${folder}/model.obj`, "v 0 0 0"),
      file(`${folder}/model.mtl`, "map_Kd textures/wood.png"),
      file(`${folder}/textures/wood.png`, folder),
      file(`${folder}/model.png`, folder),
    ]);
    const grouped = groupObjImportSidecars(files);
    expect(grouped.objs.map(({ obj, sidecars }) => [obj.name, sidecars.map((entry) => entry.name).sort()])).toEqual([
      ["Chair/model.obj", ["Chair/model.mtl", "Chair/model.png", "Chair/textures/wood.png"]],
      ["Table/model.obj", ["Table/model.mtl", "Table/model.png", "Table/textures/wood.png"]],
    ]);
    expect(grouped.rest).toEqual([]);
  });

  it("lets two OBJs share a texture both MTLs name", () => {
    const grouped = groupObjImportSidecars([
      file("tree.obj"),
      file("tree.mtl", "map_Kd colormap.png"),
      file("house.obj"),
      file("house.mtl", "map_Kd colormap.png"),
      file("colormap.png"),
    ]);
    expect(grouped.objs.map(({ sidecars }) => sidecars.map((entry) => entry.name).sort())).toEqual([
      ["colormap.png", "tree.mtl"],
      ["colormap.png", "house.mtl"],
    ]);
    expect(grouped.rest).toEqual([]);
  });

  it("keeps a lone OBJ with no sidecars", () => {
    const grouped = groupObjImportSidecars([file("crate.obj")]);
    expect(grouped.objs[0]!.sidecars).toEqual([]);
    expect(grouped.rest).toEqual([]);
  });
});
