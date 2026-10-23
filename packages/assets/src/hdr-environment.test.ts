import { describe, expect, it } from "vitest";
import { buildRadianceHdrFixture } from "@haptic/test-kit/environment-fixtures";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { projectContentRoot } from "./content-root";
import { isEnvironmentTexturePayload, readEnvironmentTextureInfo } from "./environment-texture";
import { decodeHasset } from "./hasset";
import {
  cubeMipChain,
  cubeTexelDirection,
  equirectangularToCube,
  hdrEnvironmentFaceSize,
  prefilterCubeRadiance,
  type CubeFaces,
} from "./hdr-environment";
import { decodeRadianceHdr } from "./radiance-hdr";
import { AssetRegistry } from "./registry";

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];

function texel(faces: CubeFaces, size: number, face: number, x: number, y: number): number[] {
  const at = (y * size + x) * 3;
  return Array.from(faces[face]!.subarray(at, at + 3));
}

function halfToFloat(bits: number): number {
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  return exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** First texel of `face` at mip 0 in an RGBA16F cube DDS, faces stored with their mips in order. */
function ddsFirstTexel(dds: Uint8Array, face: number): number[] {
  const view = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
  const size = view.getUint32(16, true);
  let faceTexels = 0;
  for (let edge = size; edge >= 1; edge /= 2) faceTexels += edge * edge;
  const offset = 128 + face * faceTexels * 8;
  return [0, 1, 2].map((channel) => halfToFloat(view.getUint16(offset + channel * 2, true)));
}

describe("Radiance HDR decoding", () => {
  const pattern = (x: number, y: number): Rgb =>
    x === 3 ? BLACK : [x < 4 ? 1 : 0.5, y === 0 ? 3 : 0.25, x / 8];

  it.each([false, true])("decodes flat and run-length RGBE scanlines exactly (runLength=%s)", (runLength) => {
    const image = decodeRadianceHdr(buildRadianceHdrFixture({ width: 8, height: 2, color: pattern, runLength }));
    expect(image.width).toBe(8);
    expect(image.height).toBe(2);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 8; x++)
        expect(Array.from(image.rgb.subarray((y * 8 + x) * 3, (y * 8 + x) * 3 + 3))).toEqual([...pattern(x, y)]);
  });

  it("box-averages blocks when downsampling, including partial edge blocks", () => {
    const image = decodeRadianceHdr(
      buildRadianceHdrFixture({ width: 9, height: 3, color: (x, y) => [x === 8 ? 2 : x % 2, y === 2 ? 1 : 0, 0] }),
      2,
    );
    expect([image.width, image.height]).toEqual([5, 2]);
    expect(Array.from(image.rgb.subarray(0, 3))).toEqual([0.5, 0, 0]);
    // The last column and row hold one source pixel each.
    expect(Array.from(image.rgb.subarray(4 * 3, 5 * 3))).toEqual([2, 0, 0]);
    expect(Array.from(image.rgb.subarray(5 * 3, 6 * 3))).toEqual([0.5, 1, 0]);
  });

  it("rejects unsupported formats, orientations and truncated pixel data", () => {
    const build = (header: string) => buildRadianceHdrFixture({ width: 8, height: 2, color: () => BLACK, header });
    expect(() => decodeRadianceHdr(build("#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 2 +X 8\n"))).toThrow(/xyze/);
    expect(() => decodeRadianceHdr(build("#?RADIANCE\n\n+Y 2 +X 8\n"))).toThrow(/orientation/);
    expect(() => decodeRadianceHdr(build("P6\n"))).toThrow(/signature/);
    const source = buildRadianceHdrFixture({ width: 8, height: 2, color: () => [1, 1, 1], runLength: true });
    expect(() => decodeRadianceHdr(source.subarray(0, source.length - 1))).toThrow(/truncated/);
  });
});

describe("equirectangular to cube projection", () => {
  // Babylon's HDRCubeTexture orientation: the panorama centre faces +Z, three
  // quarters across faces +X and the top row is +Y. Each panorama lights one
  // half-space, so every face and texel orientation is pinned by its sign.
  const width = 64;
  const height = 32;
  const lit: Rgb = [1, 1, 1];
  const halfSpaces = {
    up: (_x: number, y: number) => (y < height / 2 ? lit : BLACK),
    right: (x: number) => (x >= width / 2 ? lit : BLACK),
    forward: (x: number) => (x >= width / 4 && x < (3 * width) / 4 ? lit : BLACK),
  };
  const size = 8;
  const cube = (key: keyof typeof halfSpaces) =>
    equirectangularToCube(decodeRadianceHdr(buildRadianceHdrFixture({ width, height, color: halfSpaces[key] })), size);
  const lum = (faces: CubeFaces, face: number, x: number, y: number) => texel(faces, size, face, x, y)[0]!;
  const near = 1;
  const far = size - 2;

  it("lights only the faces and texels in each half-space, in WebGL cube face order", () => {
    const up = cube("up");
    expect([0, 1, 2, 3, 4, 5].map((face) => lum(up, face, near, near))).toEqual([1, 1, 1, 0, 1, 1]);
    // Side faces store their top row first.
    for (const face of [0, 1, 4, 5]) expect(lum(up, face, near, far)).toBe(0);

    const right = cube("right");
    expect(lum(right, 0, near, near)).toBe(1);
    expect(lum(right, 1, far, far)).toBe(0);
    expect([lum(right, 4, far, near), lum(right, 4, near, near)]).toEqual([1, 0]);
    expect([lum(right, 5, near, near), lum(right, 5, far, near)]).toEqual([1, 0]);
    expect([lum(right, 2, far, near), lum(right, 2, near, near)]).toEqual([1, 0]);

    const forward = cube("forward");
    expect([lum(forward, 4, near, near), lum(forward, 5, far, far)]).toEqual([1, 0]);
    expect([lum(forward, 0, near, near), lum(forward, 0, far, near)]).toEqual([1, 0]);
    expect([lum(forward, 1, far, near), lum(forward, 1, near, near)]).toEqual([1, 0]);
    expect([lum(forward, 2, near, far), lum(forward, 2, near, near)]).toEqual([1, 0]);
    expect([lum(forward, 3, near, near), lum(forward, 3, near, far)]).toEqual([1, 0]);
  });
});

describe("GGX radiance prefiltering", () => {
  const size = 16;
  // A soft off-axis sun over a dim sky: its spread depends strongly on roughness.
  const sun = [0.48, 0.6, 0.64];
  const environment = (d: readonly number[]) => {
    const lobe = Math.max(0, d[0]! * sun[0]! + d[1]! * sun[1]! + d[2]! * sun[2]!) ** 8;
    return [0.2 + 3 * lobe, 0.2 + 2 * lobe, 0.5 + 0.5 * lobe];
  };
  function analyticCube(): CubeFaces {
    return [0, 1, 2, 3, 4, 5].map((face) => {
      const pixels = new Float32Array(size * size * 3);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) pixels.set(environment(cubeTexelDirection(face, size, x, y)), (y * size + x) * 3);
      return pixels;
    });
  }

  /** Brute-force split-sum radiance (V = N) over every base texel, weighted by solid angle. */
  function reference(base: CubeFaces, n: readonly number[], alpha: number): number[] {
    const sum = [0, 0, 0];
    let total = 0;
    const a2 = alpha * alpha;
    for (let face = 0; face < 6; face++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const l = cubeTexelDirection(face, size, x, y);
          const noL = n[0]! * l[0] + n[1]! * l[1] + n[2]! * l[2];
          if (noL <= 0) continue;
          const s = ((x + 0.5) / size) * 2 - 1;
          const t = ((y + 0.5) / size) * 2 - 1;
          const solidAngle = (1 + s * s + t * t) ** -1.5;
          const noH = Math.sqrt((1 + noL) / 2);
          const d = noH * noH * (a2 - 1) + 1;
          const weight = noL * (a2 / (Math.PI * d * d)) * solidAngle;
          const color = texel(base, size, face, x, y);
          for (let channel = 0; channel < 3; channel++) sum[channel]! += color[channel]! * weight;
          total += weight;
        }
    return sum.map((value) => value / total);
  }

  it("keeps mip 0 and matches the GGX integral at Babylon's roughness for every other mip", async () => {
    const base = analyticCube();
    const levels = await prefilterCubeRadiance(cubeMipChain(base, size), size);
    expect(levels).toHaveLength(5);
    expect(levels[0]).toBe(base);
    for (let level = 1; level < levels.length; level++) {
      const edge = size >> level;
      // Babylon's HDRFiltering roughness for mip `level`, read back with LOD scale 0.8.
      // Filtered importance sampling reads blurrier source mips than this exact
      // integral, most at mip 1 (about 0.06 here); a LOD scale of 1 instead of 0.8
      // moves mips 1-3 by 0.15-0.3.
      const alpha = 2 ** (level / 0.8) / size;
      for (let face = 0; face < 6; face++)
        for (let y = 0; y < edge; y++)
          for (let x = 0; x < edge; x++) {
            const expected = reference(base, cubeTexelDirection(face, edge, x, y), alpha);
            const actual = texel(levels[level]!, edge, face, x, y);
            for (let channel = 0; channel < 3; channel++)
              expect(Math.abs(actual[channel]! - expected[channel]!), `mip ${level} face ${face} (${x}, ${y})`).toBeLessThan(0.075);
          }
    }
  });
});

describe("HDR environment import", () => {
  it("sizes faces from a quarter of the panorama width, capped at 256", () => {
    expect([8, 60, 1000, 2048, 8192].map(hdrEnvironmentFaceSize)).toEqual([2, 16, 256, 256, 256]);
  });

  it("imports a panorama as a prefiltered RGBA16F DDS cube that registers as an environment Texture", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Environment.hproject");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    // +X half-space green, the rest dim blue: 64 wide gives 16×16 faces.
    const source = buildRadianceHdrFixture({
      width: 64,
      height: 32,
      color: (x) => (x >= 32 ? [0, 2, 0] : [0, 0, 0.5]),
      runLength: true,
    });
    const [asset] = await registry.importFile("project", "", "Sky.hdr", source);
    expect(asset!.header).toMatchObject({ type: "Texture", name: "Sky", dependencies: [] });
    expect(asset!.header.payload).toEqual({
      usage: "skybox",
      dimension: "cube",
      container: "dds",
      encoding: "linearFloat16",
      width: 16,
      height: 16,
      mipLevels: 5,
      prefiltered: true,
      hasIrradiance: false,
    });
    expect(isEnvironmentTexturePayload(asset!.header.payload)).toBe(true);
    const dds = (await decodeHasset(await storage.readBinary(asset!.path))).chunks.get("source")!;
    expect(readEnvironmentTextureInfo(dds)).toMatchObject({ container: "dds", width: 16, mipLevels: 5 });
    // Faces upload in +X, -X, +Y, -Y, +Z, -Z order.
    expect(ddsFirstTexel(dds, 0)).toEqual([0, 2, 0]);
    expect(ddsFirstTexel(dds, 1)).toEqual([0, 0, 0.5]);
  });
});
