import { Constants, RawTexture3D, Texture, type BaseTexture, type Scene } from "@babylonjs/core";
import type { MeshAssetContext } from "./mesh-assets";

/**
 * Convert an RGBA strip of `size` square slices side by side (width =
 * size * size, height = size) into 3D texel order: x = red, y = green
 * (top row first), z = blue (left slice first). Null when the image is not a
 * strip.
 */
export function lutStripToVolume(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { size: number; data: Uint8Array } | null {
  const size = height;
  if (size < 2 || width !== size * size || pixels.length < width * height * 4) return null;
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++) {
      const source = (g * width + b * size) * 4;
      data.set(pixels.subarray(source, source + size * 4), ((b * size + g) * size) * 4);
    }
  return { size, data };
}

async function decodeStrip(bytes: Uint8Array | Blob) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
    imageOrientation: "none",
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return lutStripToVolume(image.data, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * One Scene's color grading LUT. The requested Texture asset's source pixels
 * become an owned bilinear 3D texture, which Babylon samples natively on both
 * WebGL2 and WebGPU. `onChange` publishes the texture only once it exists (or
 * null), so the effect plan never compiles a Display Color stage without it.
 */
export class ColorGradingSource {
  private readonly scene: Scene;
  private readonly onChange: (texture: BaseTexture | null) => void;
  private textureBytes: ReadonlyMap<string, Uint8Array | Blob> | undefined;
  private guid: string | null = null;
  private bytes: Uint8Array | Blob | undefined;
  private request = 0;
  private texture: RawTexture3D | null = null;
  private readonly retiring = new Set<RawTexture3D>();
  private disposed = false;

  constructor(scene: Scene, onChange: (texture: BaseTexture | null) => void) {
    this.scene = scene;
    this.onChange = onChange;
  }

  setAssets(assets: MeshAssetContext | undefined): void {
    this.textureBytes = assets?.textureBytes;
    this.sync(this.guid);
  }

  /** Null clears grading; an unloaded, missing or malformed LUT grades nothing. */
  sync(guid: string | null): void {
    if (this.disposed) return;
    const bytes = guid ? this.textureBytes?.get(guid) : undefined;
    if (guid === this.guid && bytes === this.bytes) return;
    this.guid = guid;
    this.bytes = bytes;
    const request = ++this.request;
    this.replace(null);
    if (!guid || !bytes) return;
    void decodeStrip(bytes).then((volume) => {
      if (request !== this.request || this.disposed || this.scene.isDisposed) return;
      if (!volume) {
        console.warn(`Color grading LUT ${guid} must be a strip of square slices, such as 256x16 or 1024x32.`);
        return;
      }
      const texture = new RawTexture3D(
        volume.data, volume.size, volume.size, volume.size,
        Constants.TEXTUREFORMAT_RGBA, this.scene, false, false,
        Texture.BILINEAR_SAMPLINGMODE,
      );
      texture.name = `Color Grading LUT ${guid}`;
      texture.wrapU = texture.wrapV = texture.wrapR = Texture.CLAMP_ADDRESSMODE;
      this.replace(texture);
    }, (error: unknown) => {
      if (request === this.request) console.warn(`Color grading LUT ${guid} could not be decoded.`, error);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.request++;
    this.replace(null);
    for (const texture of this.retiring) texture.dispose();
    this.retiring.clear();
  }

  private replace(next: RawTexture3D | null): void {
    const previous = this.texture;
    if (previous === next) return;
    this.texture = next;
    this.onChange(next);
    if (!previous) return;
    if (this.disposed || this.scene.isDisposed) {
      previous.dispose();
      return;
    }
    // The last plan may still reference the texture until its chain rebuilds
    // at the next view boundary; dispose after that frame, or on disposal.
    this.retiring.add(previous);
    this.scene.onAfterRenderObservable.addOnce(() => {
      if (this.retiring.delete(previous)) previous.dispose();
    });
  }
}
