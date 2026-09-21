/** Native preprocessing oracle is test-only; production uses committed derived data. */
import { Constants, Scene, Texture, type AbstractEngine } from "@babylonjs/core";
import { AreaLightTextureTools } from "@babylonjs/core/Misc/areaLightsTextureTools";
import { decodeAreaEmission, sha256Hex } from "@babylonslate/assets";
import { processAreaEmissionInWorker } from "@babylonslate/assets/area-emission-client";
import { encodeRgbaPng } from "@babylonslate/render";

export async function qualifyAreaEmission(engine: AbstractEngine) {
  const width = 32, height = 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([24 + x * 7, 36 + y * 12, x < width / 2 ? 32 : 216, 255], (y * width + x) * 4);
  const source = await encodeRgbaPng(width, height, rgba);
  const progress: string[] = [];
  const prepared = await processAreaEmissionInWorker({ source, sourceHash: await sha256Hex(source), mime: "image/png" }, new AbortController().signal, (value) => {
    if (progress.at(-1) !== value.phase) progress.push(value.phase);
  });
  const decoded = await decodeAreaEmission(prepared);
  const scene = new Scene(engine);
  const url = URL.createObjectURL(new Blob([source.slice()], { type: "image/png" }));
  const original = new Texture(url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
  const processor = new AreaLightTextureTools(engine);
  try {
    const native = await processor.processAsync(original);
    const pixels = await native.readPixels();
    if (!pixels) { native.dispose(); throw new Error("Native emission preprocessing produced no pixels."); }
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    let maxError = 0, totalError = 0, flippedError = 0;
    for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) for (let c = 0; c < 3; c++) {
      const offset = (y * 1024 + x) * 4 + c;
      const error = Math.abs(bytes[offset]! - decoded.rgba[offset]!);
      totalError += error; maxError = Math.max(maxError, error);
      flippedError += Math.abs(bytes[offset]! - decoded.rgba[((1023 - y) * 1024 + x) * 4 + c]!);
    }
    // Separate preprocessing parity from upload/binding parity. A one-byte
    // native raster quantization difference can cross a hard CEL threshold.
    // The render oracle follows the native final upload into its render target,
    // using identical validated bytes so the presented images must match exactly.
    engine.updateRawTexture(native.getInternalTexture()!, decoded.rgba, Constants.TEXTUREFORMAT_RGBA, false);
    return { native, emissions: new Map([["pattern", decoded]]), report: { processor: decoded.metadata.processor, progress, maxError, meanError: totalError / (1024 ** 2 * 3), verticallyFlippedMeanError: flippedError / (1024 ** 2 * 3), sourceHash: decoded.metadata.sourceHash, renderOracle: "native render target with identical prepared pixels" } };
  } finally { processor.dispose(); original.dispose(); scene.dispose(); URL.revokeObjectURL(url); }
}
