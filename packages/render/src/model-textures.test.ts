import { describe, expect, it } from "vitest";
import {
  slimGlbEmbeddedImages,
} from "./model-textures";

/** Build a minimal valid GLB with the given JSON + BIN payloads. */
function makeGlb(
  json: Record<string, unknown>,
  bin: Uint8Array = new Uint8Array(16),
): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length;
  const out = new Uint8Array(total).fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad); // spec: space-padded JSON
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // glTF
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.length + jsonPad;
  view.setUint32(binAt, bin.length, true);
  view.setUint32(binAt + 4, 0x004e4942, true); // BIN
  out.set(bin, binAt + 8);
  return out;
}

function parseGlb(bytes: Uint8Array): { json: any; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  let offset = 12;
  let json: any;
  let bin = new Uint8Array();
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    if (type === 0x004e4942) bin = body;
    offset += 8 + length;
  }
  return { json, bin };
}

function pngMagicOnly(byteLength = 10): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(byteLength - 4).fill(7)]);
}

describe("slimGlbEmbeddedImages", () => {
  it("replaces embedded raster images with named placeholders and appends BIN data", () => {
    const glb = makeGlb({
      asset: { version: "2.0" },
      images: [
        { bufferView: 0, mimeType: "image/png" }, // non-square source
        { bufferView: 1, mimeType: "image/jpeg" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 12 },
        { buffer: 0, byteOffset: 12, byteLength: 4 },
      ],
    });
    const slim = slimGlbEmbeddedImages(glb);
    expect(slim).not.toBeNull();
    expect(slim!.replacedCount).toBe(2);

    const { json } = parseGlb(slim!.bytes);
    expect(json.images[0].name).toBe("__bsl_img_0");
    expect(json.images[1].name).toBe("__bsl_img_1");
    // Both point at ONE appended placeholder view at the tail.
    const views = json.bufferViews;
    const lastIndex = views.length - 1;
    expect(json.images[0].bufferView).toBe(lastIndex);
    expect(json.images[1].bufferView).toBe(lastIndex);
    expect(json.images[0].mimeType).toBe("image/png");
  });

  it("leaves URI-referenced and already-KTX2 images untouched", () => {
    const glb = makeGlb({
      asset: { version: "2.0" },
      images: [
        { uri: "external.png", mimeType: "image/png" },
        { bufferView: 0, mimeType: "image/ktx2" },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
    });
    const slim = slimGlbEmbeddedImages(glb);
    expect(slim).toBeNull(); // nothing to replace -> no transform
  });

  it("preserves non-image JSON fields and original BIN bytes", () => {
    const glb = makeGlb(
      {
        asset: { version: "2.0" },
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [{ name: "root" }],
        animations: [{ name: "walk", channels: [] }],
        images: [{ bufferView: 0, mimeType: "image/png" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 16 }],
      },
      new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]),
    );
    const slim = slimGlbEmbeddedImages(glb)!;
    const { json, bin } = parseGlb(slim.bytes);
    expect(json.animations).toEqual([{ name: "walk", channels: [] }]);
    expect(json.nodes).toEqual([{ name: "root" }]);
    // Original 16 BIN bytes survive at the head of the (grown) BIN chunk.
    expect(Array.from(bin.subarray(0, 16))).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]);
    // Placeholder PNG magic lives where the new bufferView points.
    const view = json.bufferViews[json.bufferViews.length - 1];
    expect(Array.from(bin.subarray(view.byteOffset, view.byteOffset + 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
  });

  it("returns null for malformed input instead of throwing", () => {
    expect(slimGlbEmbeddedImages(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(slimGlbEmbeddedImages(pngMagicOnly())).toBeNull();
    const badView = makeGlb({
      asset: { version: "2.0" },
      images: [{ bufferView: 99, mimeType: "image/png" }],
      bufferViews: [],
    });
    expect(slimGlbEmbeddedImages(badView)).toBeNull();
  });
});
