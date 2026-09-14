import { expect, it } from "vitest";
import { materialParameterTextureAssetGuids } from "./material-parameter-textures";

it("excludes loaded ENV and DDS cubes from runtime 2D Texture parameter admission", () => {
  const textures = new Map([
    ["color", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ["sky-env", new Uint8Array([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36])],
    ["sky-dds", new Uint8Array([0x44, 0x44, 0x53, 0x20])],
  ]);
  expect(materialParameterTextureAssetGuids(textures)).toEqual(["color"]);
  expect([...textures.keys()]).toEqual(["color", "sky-env", "sky-dds"]);
});
