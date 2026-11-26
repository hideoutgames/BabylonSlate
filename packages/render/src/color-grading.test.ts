import { packRawRgbaTexture } from "@haptic/assets";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { expect, it } from "vitest";
import { ColorGradingSource, lutStripToVolume } from "./color-grading";

it("reorders a LUT strip into red, green, blue volume order", () => {
  // A 4x2 strip: two 2x2 slices. Each texel stores its own (r, g, b) index.
  const strip = new Uint8Array(4 * 2 * 4);
  for (let g = 0; g < 2; g++)
    for (let b = 0; b < 2; b++)
      for (let r = 0; r < 2; r++) strip.set([r, g, b, 255], (g * 4 + b * 2 + r) * 4);
  const volume = lutStripToVolume(strip, 4, 2)!;
  expect(volume.size).toBe(2);
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++)
      for (let r = 0; r < 2; r++) {
        const index = ((b * 2 + g) * 2 + r) * 4;
        expect([...volume.data.subarray(index, index + 3)]).toEqual([r, g, b]);
      }
});

it("rejects images that are not square-slice strips", () => {
  expect(lutStripToVolume(new Uint8Array(16 * 16 * 4), 16, 16)).toBeNull();
  expect(lutStripToVolume(new Uint8Array(4), 1, 1)).toBeNull();
  expect(lutStripToVolume(new Uint8Array(8), 4, 2)).toBeNull();
});

it("decodes HRGB raw-RGBA LUT strip bytes without relying on createImageBitmap", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const strip = new Uint8Array(4 * 2 * 4).fill(255);
    const hrgb = packRawRgbaTexture(4, 2, strip);
    let published: unknown = null;
    const ready = new Promise<void>((resolve) => {
      const source = new ColorGradingSource(scene, (texture) => {
        if (texture) {
          published = texture;
          resolve();
        }
      });
      source.setAssets({ textureBytes: new Map([["lut-1", hrgb]]) });
      source.sync("lut-1");
    });
    await ready;
    expect(published).not.toBeNull();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
