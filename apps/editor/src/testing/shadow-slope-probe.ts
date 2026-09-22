/** Test-only raster slope experiment; never installed by production rendering. */
import {
  CascadedShadowGenerator,
  DirectionalLight,
  ShadowGenerator,
} from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { readEngineDrawCalls } from "@babylonslate/render";

type RasterOffsets = { factor: number; units: number };

/**
 * Bracket actual caster batches with native slope bias. Install after graph
 * preparation, keep manual shader bias fixed, and dispose in the caller's
 * finally block: Babylon does not guarantee its after-hook when a draw throws.
 */
export function installSingleMapPcfSlopeProbe(
  generator: ShadowGenerator,
  factor: number,
) {
  if (![0.5, 0.75, 1, 1.25].includes(factor))
    throw new Error("Unsupported diagnostic slope factor");
  const light = generator.getLight();
  const engine = light.getScene().getEngine();
  const map = generator.getShadowMap();
  const assertSupported = () => {
    if (
      !(light instanceof DirectionalLight) ||
      generator instanceof CascadedShadowGenerator ||
      !generator.usePercentageCloserFiltering ||
      generator.useContactHardeningShadow ||
      !map ||
      map.isCube ||
      map.is2DArray ||
      generator.getShadowMap() !== map ||
      light.getShadowGenerator() !== generator ||
      generator.forceBackFacesOnly
    )
      throw new Error("Slope probe requires an ordinary directional PCF map");
    if (
      engine instanceof WebGPUEngine &&
      (!engine.compatibilityMode || engine.snapshotRendering)
    )
      throw new Error("Slope probe excludes WebGPU bundle and snapshot reuse");
  };
  assertSupported();
  if (!map) throw new Error("Slope probe requires an allocated shadow map");

  const readOffsets = (): RasterOffsets => ({
    factor: engine.getZOffset(),
    units: engine.getZOffsetUnits(),
  });
  const initialOffsets = readOffsets();
  let previous: RasterOffsets | undefined;
  let lastBefore: RasterOffsets | null = null;
  let lastApplied: RasterOffsets | null = null;
  let lastRestored: RasterOffsets | null = null;
  let disposed = false;
  let casterBatches = 0;
  let completedBatches = 0;
  let drawCalls = 0;
  let drawsBefore = 0;

  const restore = () => {
    if (!previous) return;
    engine.setZOffset(previous.factor);
    engine.setZOffsetUnits(previous.units);
    lastRestored = readOffsets();
    previous = undefined;
  };
  const before = generator.onBeforeShadowMapRenderObservable.add(() => {
    assertSupported();
    if (previous)
      throw new Error("Unexpected nested caster batch in slope probe");
    previous = readOffsets();
    lastBefore = previous;
    drawsBefore = readEngineDrawCalls(engine);
    // Public setters already reverse the sign for reverse-depth engines.
    // Preserve constant raster units and the separately bound shader bias.
    engine.setZOffset(factor);
    lastApplied = readOffsets();
    casterBatches++;
  });
  const after = generator.onAfterShadowMapRenderObservable.add(() => {
    if (previous) {
      completedBatches++;
      drawCalls += Math.max(0, readEngineDrawCalls(engine) - drawsBefore);
    }
    restore();
  });
  const mapDisposed = map.onDisposeObservable.add(() => dispose());

  function dispose() {
    if (disposed) return;
    disposed = true;
    restore();
    generator.onBeforeShadowMapRenderObservable.remove(before);
    generator.onAfterShadowMapRenderObservable.remove(after);
    map!.onDisposeObservable.remove(mapDisposed);
  }

  return {
    dispose,
    get evidence() {
      return {
        factor,
        casterBatches,
        completedBatches,
        drawCalls,
        pendingRestore: previous !== undefined,
        disposed,
        reverseDepth: engine.useReverseDepthBuffer,
        nativeDepthBias: generator.bias,
        normalBias: generator.normalBias,
        initialOffsets,
        lastBefore,
        lastApplied,
        lastRestored,
      };
    },
  };
}
