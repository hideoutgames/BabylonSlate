/** Native preprocessing oracle is test-only; production uses committed derived data. */
import { Constants, Scene, Texture, type AbstractEngine } from "@babylonjs/core";
import { AreaLightTextureTools } from "@babylonjs/core/Misc/areaLightsTextureTools";
import { decodeAreaEmission, sha256Hex } from "@babylonslate/assets";
import { processAreaEmissionInWorker } from "@babylonslate/assets/area-emission-client";
import { AREA_EMISSION_INTERIOR, resampleAreaEmissionSource } from "@babylonslate/assets/area-emission-processing";
import { encodeRgbaPng } from "@babylonslate/render";

export async function qualifyAreaEmission(engine: AbstractEngine, sourceSize: readonly [number, number] = [32, 16]) {
  const [width, height] = sourceSize;
  const minified = Math.max(width, height) > 768;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(minified
    ? [x % 2 ? 255 : 0, 32 + Math.floor(y / height * 192), x < width / 2 ? 32 : 216, 255]
    : [24 + x * 7, 36 + y * 12, x < width / 2 ? 32 : 216, 255], (y * width + x) * 4);
  const source = await encodeRgbaPng(width, height, rgba);
  const progress: string[] = [];
  const prepared = await processAreaEmissionInWorker({ source, sourceHash: await sha256Hex(source), mime: "image/png" }, new AbortController().signal, (value) => {
    if (progress.at(-1) !== value.phase) progress.push(value.phase);
  });
  const decoded = await decodeAreaEmission(prepared);
  // Source filtering is deterministic import policy. Independently qualify the
  // native mirrored copy/encoding/blur against that same prefiltered raster.
  const canonical = await resampleAreaEmissionSource(rgba, width, height);
  const nativeSource = await encodeRgbaPng(AREA_EMISSION_INTERIOR, AREA_EMISSION_INTERIOR, canonical);
  const scene = new Scene(engine);
  const url = URL.createObjectURL(new Blob([nativeSource.slice()], { type: "image/png" }));
  const original = new Texture(url, scene, true, true, Texture.BILINEAR_SAMPLINGMODE);
  original.anisotropicFilteringLevel = 1;
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
    return { native, emissions: new Map([["pattern", decoded]]), report: { processor: decoded.metadata.processor, sourceSize, progress, maxError, meanError: totalError / (1024 ** 2 * 3), verticallyFlippedMeanError: flippedError / (1024 ** 2 * 3), sourceHash: decoded.metadata.sourceHash, renderOracle: "native render target with identical prepared pixels" } };
  } finally { processor.dispose(); original.dispose(); scene.dispose(); URL.revokeObjectURL(url); }
}
