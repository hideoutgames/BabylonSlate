import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKYBOX_FACE_SIZE,
  generateDefaultSkyboxFaceRgba,
} from "./faces";
import { encodePngRgba } from "./png";

function lumaAt(
  rgba: Uint8Array,
  size: number,
  x: number,
  y: number,
): number {
  const i = (y * size + x) * 4;
  return 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
}

function averageLuma(rgba: Uint8Array): number {
  let sum = 0;
  const pixels = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    sum += 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
  }
  return sum / pixels;
}

describe("default skybox geometric faces", () => {
  it("uses a power-of-two face size", () => {
    expect(DEFAULT_SKYBOX_FACE_SIZE).toBeGreaterThan(1);
    expect(Number.isInteger(Math.log2(DEFAULT_SKYBOX_FACE_SIZE))).toBe(true);
  });

  it("makes the zenith brighter than the nadir", () => {
    const size = 8;
    const py = generateDefaultSkyboxFaceRgba("py", size);
    const ny = generateDefaultSkyboxFaceRgba("ny", size);
    expect(py.byteLength).toBe(size * size * 4);
    expect(averageLuma(py)).toBeGreaterThan(averageLuma(ny));
  });

  it("puts sky above the horizon on side faces", () => {
    const size = 8;
    const pz = generateDefaultSkyboxFaceRgba("pz", size);
    const top = lumaAt(pz, size, 4, 1);
    const bottom = lumaAt(pz, size, 4, 6);
    expect(top).toBeGreaterThan(bottom);
  });

  it("encodes a PNG so missing faces can join CreateFromImages", () => {
    const rgba = generateDefaultSkyboxFaceRgba("px", 4);
    const png = encodePngRgba(4, 4, rgba);
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
