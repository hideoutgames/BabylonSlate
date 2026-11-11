import { appIconCrop, appIconSizeHint } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import { APP_ICON_SIZES, encodeOpaquePng, type AppIconImages } from "@haptic/exporter/app-icon";

/** What reading the App Icon's source image needs from the project. */
export interface AppIconSourceHost {
  getByGuid(guid: string): IndexedAsset | undefined;
  readAssetChunk(path: string, chunkId: string): Promise<Uint8Array | null>;
}

const CHOOSE_ANOTHER = "Choose another in Project Settings > Export.";

/**
 * The App Icon Texture's source image (its `pixels` chunk, the file it was
 * imported from), never its GPU encode: icons are cut from full-resolution
 * pixels.
 */
export async function readAppIconSource(host: AppIconSourceHost, guid: string): Promise<Blob> {
  const asset = host.getByGuid(guid);
  if (!asset || asset.header.type !== "Texture") throw new Error(`The App Icon Texture is missing. ${CHOOSE_ANOTHER}`);
  const pixels = asset.header.chunks.find((chunk) => chunk.kind === "pixels" || chunk.id === "pixels");
  const bytes = pixels ? await host.readAssetChunk(asset.path, pixels.id) : null;
  if (!pixels || !bytes) throw new Error(`The App Icon Texture ${asset.header.name} has no source image. ${CHOOSE_ANOTHER}`);
  return new Blob([new Uint8Array(bytes)], { type: pixels.mime ?? "image/png" });
}

/** The App Icon Texture's problem as Project Settings shows it: only a missing Texture; any size packages. */
export function appIconTextureProblem(asset: IndexedAsset | undefined): string | null {
  return !asset || asset.header.type !== "Texture" ? "The Texture is missing." : null;
}

/** Project Settings' note for an App Icon Texture that packaging crops or scales up, from its recorded source size. */
export function appIconTextureHint(asset: IndexedAsset | undefined): string | null {
  if (!asset || asset.header.type !== "Texture") return null;
  const { width, height } = asset.header.payload;
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? appIconSizeHint({ width, height }) : null;
}

function drawSquare(source: CanvasImageSource, from: number, to: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(to, to);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The App Icon could not be drawn: this browser has no 2D canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, from, from, 0, 0, to, to);
  return canvas;
}

/** The source's centre square (`appIconCrop`) at full resolution. */
function centreSquare(bitmap: ImageBitmap): { level: CanvasImageSource; edge: number } {
  const { x, y, edge } = appIconCrop(bitmap);
  if (edge === 0) throw new Error(`The App Icon Texture has no pixels. ${CHOOSE_ANOTHER}`);
  if (bitmap.width === bitmap.height) return { level: bitmap, edge };
  const canvas = new OffscreenCanvas(edge, edge);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The App Icon could not be drawn: this browser has no 2D canvas.");
  context.drawImage(bitmap, x, y, edge, edge, 0, 0, edge, edge);
  return { level: canvas, edge };
}

/**
 * PNGs of the source's centre square at every `APP_ICON_SIZES` edge. Each
 * size is drawn from a copy at most twice its size, halving from the source,
 * so small icons average every source pixel instead of sampling a few; sizes
 * above the source's edge are scaled up from it.
 */
export async function renderAppIconImages(source: Blob): Promise<AppIconImages> {
  const bitmap = await createImageBitmap(source);
  try {
    let { level, edge } = centreSquare(bitmap);
    const images = new Map<number, Uint8Array>();
    for (const size of [...APP_ICON_SIZES].sort((a, b) => b - a)) {
      while (edge / 2 >= size) {
        const half = Math.floor(edge / 2);
        level = drawSquare(level, edge, half);
        edge = half;
      }
      const blob = await drawSquare(level, edge, size).convertToBlob({ type: "image/png" });
      images.set(size, new Uint8Array(await blob.arrayBuffer()));
    }
    return images;
  } finally {
    bitmap.close();
  }
}

/** An App Icon PNG laid over black as an RGB PNG without an alpha channel, which the App Store requires. */
export async function opaqueAppIconPng(png: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
  try {
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    if (!context) throw new Error("The App Icon could not be drawn: this browser has no 2D canvas.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return encodeOpaquePng(bitmap.width, bitmap.height, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } finally {
    bitmap.close();
  }
}
