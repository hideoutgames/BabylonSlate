import { describe, expect, it } from "vitest";
import { encodeGlbJsonBin } from "./glb-parse";
import {
  embedGltfImportBatch,
  groupGltfImportSidecars,
} from "./gltf-import-batch";

const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function kenneyStyleSidecarGlb(name: string): { name: string; bytes: Uint8Array } {
  return {
    name,
    bytes: encodeGlbJsonBin(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: 0 }],
        images: [{ name: "colormap", uri: "Textures/colormap.png" }],
      },
      new Uint8Array(0),
    ),
  };
}

describe("groupGltfImportSidecars", () => {
  it("gives two Kenney GLBs the shared colormap PNG and drops it from rest", () => {
    const tree = kenneyStyleSidecarGlb("tree.glb");
    const house = kenneyStyleSidecarGlb("house.glb");
    const colormap = { name: "colormap.png", bytes: ONE_BY_ONE_PNG };
    const unrelated = {
      name: "readme.txt",
      bytes: new TextEncoder().encode("hi"),
    };
    const grouped = groupGltfImportSidecars([
      tree,
      house,
      colormap,
      unrelated,
    ]);
    expect(grouped.models).toHaveLength(2);
    expect(grouped.models.map((entry) => entry.model.name).sort()).toEqual([
      "house.glb",
      "tree.glb",
    ]);
    for (const entry of grouped.models) {
      expect(entry.sidecars.map((file) => file.name)).toEqual(["colormap.png"]);
    }
    expect(grouped.rest.map((file) => file.name)).toEqual(["readme.txt"]);
  });

  it("keeps a lone GLB with no matching sidecar", () => {
    const grouped = groupGltfImportSidecars([kenneyStyleSidecarGlb("crate.glb")]);
    expect(grouped.models[0]!.sidecars).toEqual([]);
    expect(grouped.rest).toEqual([]);
  });
});

describe("embedGltfImportBatch", () => {
  it("embeds the shared atlas into each GLB and does not re-import the PNG", () => {
    const prepared = embedGltfImportBatch([
      kenneyStyleSidecarGlb("tree.glb"),
      kenneyStyleSidecarGlb("house.glb"),
      { name: "colormap.png", bytes: ONE_BY_ONE_PNG },
      { name: "notes.txt", bytes: new TextEncoder().encode("x") },
    ]);
    expect(prepared.map((file) => file.name).sort()).toEqual([
      "house.glb",
      "notes.txt",
      "tree.glb",
    ]);
    const tree = prepared.find((file) => file.name === "tree.glb")!;
    expect(tree.bytes).not.toEqual(kenneyStyleSidecarGlb("tree.glb").bytes);
  });
});
