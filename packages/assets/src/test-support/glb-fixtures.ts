import { encodeGlbJsonBin } from "../importers/glb-parse";

/** Minimal valid 1×1 PNG (red pixel). */
export const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01,
  0x00, 0xf7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/** Build a minimal GLB for unit / Playwright fixtures. */
export function buildMinimalGlbFixture(options?: {
  materialName?: string;
  imageRgba?: Uint8Array;
  animationName?: string;
}): Uint8Array {
  const materialName = options?.materialName ?? "FixtureMat";
  const animationName = options?.animationName ?? "FixtureClip";
  // 2x2 opaque PNG (tiny) — or raw RGBA wrapped as a bufferView with mime png
  // Using a hand-rolled 1x1 PNG keeps the fixture self-contained.
  const png = options?.imageRgba ?? ONE_BY_ONE_PNG;
  const json = {
    asset: { version: "2.0", generator: "haptic-test" },
    buffers: [{ byteLength: png.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.byteLength }],
    images: [{ mimeType: "image/png", bufferView: 0, name: "FixtureImage" }],
    textures: [{ source: 0 }],
    materials: [
      {
        name: materialName,
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    animations: [{ name: animationName, channels: [], samplers: [] }],
    meshes: [],
    nodes: [],
    scenes: [{ nodes: [] }],
    scene: 0,
  };
  return encodeGlbJsonBin(json, png);
}
