import { describe, expect, it } from "vitest";
import { groupMsdfImportBatch } from "./msdf-import-batch";

describe("groupMsdfImportBatch", () => {
  it("pairs an MSDF JSON with a matching atlas PNG and keeps other images as textures", () => {
    const json = {
      name: "Ui-msdf.json",
      bytes: new TextEncoder().encode(
        JSON.stringify({ pages: ["Ui-msdf.png"], chars: [] }),
      ),
    };
    const png = { name: "Ui-msdf.png", bytes: new Uint8Array([1]) };
    const extra = { name: "hero.png", bytes: new Uint8Array([2]) };
    const prepared = groupMsdfImportBatch([json, png, extra]);
    expect(prepared).toHaveLength(2);
    const font = prepared.find((file) => file.name === "Ui-msdf.json");
    expect(font?.sidecars?.["Ui-msdf.png"]).toEqual(new Uint8Array([1]));
    expect(prepared.find((file) => file.name === "hero.png")).toEqual(extra);
    expect(prepared.find((file) => file.name === "Ui-msdf.png")).toBeUndefined();
  });

  it("leaves a same-family msdf PNG alone when the JSON names a different atlas page", () => {
    const json = {
      name: "Ui-msdf.json",
      bytes: new TextEncoder().encode(JSON.stringify({ pages: ["Ui-atlas.png"], chars: [] })),
    };
    const sameFamily = { name: "Ui-msdf.png", bytes: new Uint8Array([1]) };
    const named = { name: "Ui-atlas.png", bytes: new Uint8Array([2]) };
    const prepared = groupMsdfImportBatch([json, sameFamily, named]);
    expect(prepared.find((file) => file.name === "Ui-msdf.json")?.sidecars).toEqual({
      "Ui-atlas.png": named.bytes,
      "ui-atlas.png": named.bytes,
    });
    expect(prepared.find((file) => file.name === "Ui-msdf.png")).toEqual(sameFamily);
  });

  it("keeps an unpaired /msdf/ PNG so importFont can create or attach a Font", () => {
    const png = { name: "Display.msdf.png", bytes: new Uint8Array([9]) };
    expect(groupMsdfImportBatch([png])).toEqual([png]);
  });
});
