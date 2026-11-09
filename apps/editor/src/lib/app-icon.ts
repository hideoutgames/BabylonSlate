import { appIconSizeProblem } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import { APP_ICON_SIZES, type AppIconImages } from "@haptic/exporter/app-icon";

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

/** The App Icon Texture's problem as Project Settings shows it: missing, or a source size packaging refuses. */
export function appIconTextureProblem(asset: IndexedAsset | undefined): string | null {
  if (!asset || asset.header.type !== "Texture") return "The Texture is missing.";
  const { width, height } = asset.header.payload;
  return typeof width === "number" && typeof height === "number" ? appIconSizeProblem({ width, height }) : null;
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

/**
 * PNGs of the source image at every `APP_ICON_SIZES` edge. Each size is drawn
 * from a copy at most twice its size, halving from the source, so small icons
 * average every source pixel instead of sampling a few.
 */
export async function renderAppIconImages(source: Blob): Promise<AppIconImages> {
  const bitmap = await createImageBitmap(source);
  try {
    const problem = appIconSizeProblem(bitmap);
    if (problem) throw new Error(`${problem} ${CHOOSE_ANOTHER}`);
    const images = new Map<number, Uint8Array>();
    let level: CanvasImageSource = bitmap;
    let edge = bitmap.width;
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
