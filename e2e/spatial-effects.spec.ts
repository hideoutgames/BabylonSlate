import { expect, test } from "@playwright/test";
import type { runSpatialEffectsProof } from "../apps/editor/src/testing/spatial-effects-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
// CI runs these feature smokes on WebGL2 only (renderer-qualification coverage matrix).
// The combined scene renders reflections and a shadowed fog spot light together.
for (const backend of ["webgl2"] as const)
  for (const kind of ["combined"] as const) {
    test(`${kind} spatial lighting renders and retires on ${backend}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          ["warning", "error"].includes(message.type()) &&
          /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(
            message.text(),
          )
        )
          errors.push(message.text());
      });
      await page.goto("/?test=1&spatialEffectsProof=1");
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __spatialEffectsProof?: unknown })
            .__spatialEffectsProof === "function",
      );
      const result = await page
        .evaluate(
          ({ backend, kind }) =>
            (
              window as unknown as {
                __spatialEffectsProof: typeof runSpatialEffectsProof;
              }
            ).__spatialEffectsProof(backend, kind),
          { backend, kind },
        )
        .catch(async (error: unknown) => {
          await testInfo.attach("spatial-errors", {
            body: JSON.stringify(errors),
            contentType: "application/json",
          });
          throw error;
        });
      await testInfo.attach("spatial-pixels", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      expect(errors).toEqual([]);
      expect(result.reservations.reservedBytes).toBe(0);
      expect(result.captures).toHaveLength(1);
      for (const capture of result.captures) {
        const lit = capture.on.filter(
          (value, i) => i % 4 === 0 && value > capture.off[i]! + 8,
        ).length;
        expect(lit, `visible ${kind}`).toBeGreaterThan(20);
        const disabledDifference =
          capture.disabled.reduce(
            (sum, value, i) => sum + Math.abs(value - capture.off[i]!),
            0,
          ) / capture.off.length;
        expect(
          disabledDifference,
          "disabling restores scene color",
        ).toBeLessThan(1);
        const identityDifference =
          capture.identityDisplay.reduce(
            (sum, value, i) => sum + Math.abs(value - capture.on[i]!),
            0,
          ) / capture.on.length;
        expect(
          identityDifference,
          "an identity vignette preserves spatial color",
        ).toBeLessThan(0.5);
        const linearDifference =
          capture.linear.reduce(
            (sum, value, i) => sum + Math.abs(value - capture.on[i]!),
            0,
          ) / capture.on.length;
        expect(
          linearDifference,
          "linear display without tone mapping preserves spatial color",
        ).toBeLessThan(3);
        const occluded = capture.changed.filter(
          (value, i) => i % 4 === 0 && value > capture.on[i]! + 3,
        ).length;
        expect(
          occluded,
          "shadows occlude fog",
        ).toBeGreaterThan(20);
      }
    });
  }

/** Camera spans 12 x 9 world units in a 96 x 72 orthographic capture. */
function fogDarkening(before: number[], after: number[], centerX: number, centerY: number) {
  let difference = 0;
  for (let y = centerY - 1; y <= centerY + 1; y++)
    for (let x = centerX - 1; x <= centerX + 1; x++) {
      const index = (y * 96 + x) * 4;
      difference += before[index]! - after[index]!;
    }
  return difference / 9;
}

function pixelDifference(before: number[], after: number[]) {
  return before.reduce((sum, value, index) => sum + Math.abs(value - after[index]!), 0) / before.length;
}

for (const backend of ["webgl2"] as const) {
  test(`local fog volumes stay bounded and retire on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __spatialEffectsProof: typeof runSpatialEffectsProof;
    }).__spatialEffectsProof(backend, "fogVolumes"), backend).catch(async (error: unknown) => {
      await testInfo.attach("fog-volume-errors", {
        body: JSON.stringify(errors), contentType: "application/json",
      });
      throw error;
    });
    await testInfo.attach("fog-volume-pixels", {
      body: JSON.stringify(result), contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.fogCaptures).toHaveLength(1);
    for (const capture of result.fogCaptures) {
      const { off, box, moved, sphere } = capture;
      expect(off[(36 * 96 + 32) * 4], "visible neutral backdrop").toBeGreaterThan(100);
      expect(fogDarkening(off, box, 32, 36), "local fog activates with global fog disabled and density zero").toBeGreaterThan(30);
      expect(Math.abs(fogDarkening(off, box, 64, 36)), "neighboring rays remain clear").toBeLessThan(1);
      expect(pixelDifference(box, capture.overlap), "overlapping half-density media equal one full-density volume").toBeLessThan(1);

      // One diagonal crosses the rotated long axis; the other misses its short
      // axis. Sorting avoids depending on the GPU readback's vertical origin.
      const diagonals = [
        (fogDarkening(off, box, 40, 44) + fogDarkening(off, box, 24, 28)) / 2,
        (fogDarkening(off, box, 40, 28) + fogDarkening(off, box, 24, 44)) / 2,
      ].sort((a, b) => a - b);
      expect(Math.abs(diagonals[0]!), "rotated box's narrow axis").toBeLessThan(1);
      expect(diagonals[1], "rotated box's long axis").toBeGreaterThan(15);
      expect(Math.abs(fogDarkening(off, moved, 32, 36)), "live movement clears the old location").toBeLessThan(1);
      expect(fogDarkening(off, moved, 64, 36), "live movement reaches the new location").toBeGreaterThan(30);
      expect(fogDarkening(off, sphere, 74, 36), "scaled sphere extends horizontally").toBeGreaterThan(20);
      expect(Math.abs(fogDarkening(off, sphere, 64, 44)), "scaled sphere remains narrow vertically").toBeLessThan(1);
      // The ellipsoid is centered at x=2 with radii [2, 0.5, 1]. Boundary
      // pixels span x=3.44..3.69 (local x=0.72..0.84), within its falloff band.
      // The center rays remain in its dense core; both samples stay in bounds.
      const hardBoundary = fogDarkening(off, sphere, 76, 36);
      const softBoundary = fogDarkening(off, capture.softSphere, 76, 36);
      const softCore = fogDarkening(off, capture.softSphere, 64, 36);
      expect(hardBoundary - softBoundary, "edge falloff softens the same boundary rays").toBeGreaterThan(20);
      expect(softBoundary, "the soft boundary retains partial fog").toBeGreaterThan(2);
      expect(softBoundary, "the falloff band is thinner than the core").toBeLessThan(softCore / 2);
      expect(softCore, "soft edges retain a dense core").toBeGreaterThan(30);
      expect(pixelDifference(off, capture.disabled), "disabled local sources restore scene color").toBeLessThan(1);
      expect(pixelDifference(off, capture.removed), "removing the final source restores scene color").toBeLessThan(1);
      expect(fogDarkening(capture.insideOff, capture.inside, 48, 36), "camera inside a volume sees fog").toBeGreaterThan(30);
      // With scene-wide fog on, the volume's samples stay on the volume: its fog does not shift as the camera walks.
      const walked = capture.walk.map(({ clear, fogged }) => fogDarkening(clear, fogged, 48, 36));
      expect(Math.min(...walked), "the volume fogs the view with scene-wide fog on").toBeGreaterThan(30);
      expect(Math.max(...walked) - Math.min(...walked), "the volume's fog holds still as the camera moves").toBeLessThan(3);
      expect(fogDarkening(capture.beyondClear, capture.beyond, 48, 36), "Volumetric Distance does not cut Fog Volumes")
        .toBeGreaterThan(30);
      const nested = capture.nestedWalk.map(({ clear, fogged }) => fogDarkening(clear, fogged, 48, 36));
      expect(Math.min(...nested), "the nested volumes fog the view").toBeGreaterThan(30);
      expect(Math.max(...nested) - Math.min(...nested), "a short volume inside a long one keeps its own samples").toBeLessThan(3);
      // Transmittances multiply, also after the display encoding: both = scene × volume / clear.
      const { clear, sceneFog, volumeFog, both } = capture.composition;
      const at = (pixels: number[]) => fogDarkening(pixels, new Array<number>(pixels.length).fill(0), 48, 36);
      expect(at(clear) - at(sceneFog), "scene-wide fog darkens the view").toBeGreaterThan(5);
      expect(Math.abs(at(both) - at(sceneFog) * at(volumeFog) / at(clear)), "scene-wide fog and a Fog Volume darken together")
        .toBeLessThan(3);
    }
  });
}

/** Per capture that differs between two capture sets: its path, how many pixels differ and the largest colour step. */
function captureDifferences(own: unknown, seeded: unknown, path = ""): { capture: string; pixels: number; largest: number }[] {
  if (Array.isArray(own) && typeof own[0] === "number") {
    const other = seeded as number[];
    const pixels = new Set<number>();
    let largest = 0;
    own.forEach((value: number, index) => {
      const step = Math.abs(value - other[index]!);
      if (step === 0) return;
      pixels.add(Math.floor(index / 4));
      largest = Math.max(largest, step);
    });
    return pixels.size ? [{ capture: path, pixels: pixels.size, largest }] : [];
  }
  if (!own || typeof own !== "object") return [];
  return Object.entries(own).flatMap(([key, value]) =>
    captureDifferences(value, (seeded as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
}

// A game's world view starts a Fog Volume's geometry pass from the scene's depth and draws only the meshes that depth
// lacks. Every capture of the sequence must be what the pass's own draws gave, the blended pane's included, which only
// a draw of its own puts into that pass; with a multisampled scene the pass reads its resolved depth. The seeded pass
// computes a pixel's view depth from the scene's 32-bit depth where its own draws interpolate it, so where the fog's
// amount lies on a rounding boundary a few pixels come out one colour step apart.
for (const [backend, multisampled] of [["webgl2", false], ["webgl2", true], ["webgpu", false]] as const) {
  test(`a Fog Volume's geometry pass seeded from the scene's depth fogs as its own draws did on ${backend}${multisampled ? ", multisampled" : ""}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const capture = async (seedsFromSceneDepth: boolean) => {
      const result = await page.evaluate(([backend, multisampled, seedsFromSceneDepth]) => (window as unknown as {
        __spatialEffectsProof: typeof runSpatialEffectsProof;
      }).__spatialEffectsProof(backend, "fogVolumes", { seedsFromSceneDepth, multisampled }), [backend, multisampled, seedsFromSceneDepth] as const);
      expect(result.reservations.reservedBytes).toBe(0);
      expect(result.fogCaptures).toHaveLength(1);
      return result.fogCaptures[0]!;
    };
    const own = await capture(false);
    const seeded = await capture(true);
    const differences = captureDifferences(own, seeded);
    await testInfo.attach("fog-volume-seeded-pixels", { body: JSON.stringify({ differences, own, seeded }), contentType: "application/json" });
    expect(errors).toEqual([]);
    // The perspective captures are 96 x 72 too: (48, 36) is the view's centre, on the volume and behind the pane.
    const open = fogDarkening(own.composition.clear, own.composition.volumeFog, 48, 36);
    const behindPane = fogDarkening(own.pane.clear, own.pane.fogged, 48, 36);
    expect(open, "the volume fogs the open view").toBeGreaterThan(30);
    expect(Math.abs(behindPane), "the march ends at the pane, in front of the volume").toBeLessThan(1);
    // Observed: 8 pixels in one to three of the captures with scene-wide fog, whose amount follows the wall's depth.
    expect(Math.max(0, ...differences.map((difference) => difference.largest)), "no pixel is more than one colour step apart").toBeLessThanOrEqual(1);
    expect(differences.reduce((sum, difference) => sum + difference.pixels, 0), "few pixels differ at all").toBeLessThanOrEqual(64);
  });
}

/** Pixels at least `threshold` darker in `after`, red channel only. */
function darkened(before: number[], after: number[], threshold: number) {
  return before.filter((value, i) => i % 4 === 0 && value - after[i]! >= threshold).length;
}

for (const backend of ["webgl2"] as const) {
  test(`ambient occlusion darkens contact creases and retires on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __spatialEffectsProof: typeof runSpatialEffectsProof;
    }).__spatialEffectsProof(backend, "ambientOcclusion"), backend).catch(async (error: unknown) => {
      await testInfo.attach("occlusion-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("occlusion-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.occlusionCaptures).toHaveLength(1);
    const pixels = 96 * 72;
    for (const capture of result.occlusionCaptures) {
      const { off, on } = capture;
      expect(darkened(off, on, 8), "the crate's contact crease darkens").toBeGreaterThan(20);
      // Open floor and the cleared background receive no occlusion.
      const unchanged = off.filter((value, i) => i % 4 === 0 && Math.abs(value - on[i]!) <= 2).length;
      expect(unchanged, "unoccluded pixels keep scene color").toBeGreaterThan(pixels * 0.6);
      expect(on.filter((value, i) => i % 4 === 0 && value > off[i]! + 2).length, "occlusion never brightens").toBe(0);
      expect(darkened(off, capture.linear, 8), "Scene Linear keeps occlusion").toBeGreaterThan(20);
      expect(darkened(capture.orthographicOff, capture.orthographic, 8), "orthographic occlusion").toBeGreaterThan(20);
      expect(pixelDifference(off, capture.disabled), "disabling restores scene color").toBeLessThan(1);
      // A face seen almost edge-on does not occlude itself, and an object more than twice the radius in front of a
      // wall leaves no halo on it (the wall's pixels, not the darker plate's).
      const wallDarkened = capture.haloOff.filter((value, i) => i % 4 === 0 && value > 120 && value - capture.halo[i]! >= 8).length;
      expect({
      grazing: darkened(capture.grazingOff, capture.grazing, 8),
      halo: wallDarkened,
      facets: darkened(capture.facetsOff, capture.facets, 8),
    }).toEqual({ grazing: 0, halo: 0, facets: 0 });
    }
  });
}

/** Pixels whose red channel the red box's reflection raises. */
function reflected(off: number[], on: number[]) {
  return off.filter((value, i) => i % 4 === 0 && on[i]! > value + 8).length;
}

for (const backend of ["webgl2"] as const) {
  test(`reflections draw on lit and opted-in CEL surfaces but never unlit ones on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __spatialEffectsProof: typeof runSpatialEffectsProof;
    }).__spatialEffectsProof(backend, "reflections"), backend).catch(async (error: unknown) => {
      await testInfo.attach("reflection-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("reflection-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.reflectionCaptures).toHaveLength(1);
    for (const { pbr, cel, unlit } of result.reflectionCaptures) {
      expect(reflected(pbr.off, pbr.on), "a PBR graph mirror reflects").toBeGreaterThan(20);
      // The one Post Processing setting drives CEL too; there is no CEL-only switch.
      expect(reflected(cel.off, cel.on), "a CEL graph mirror reflects").toBeGreaterThan(20);
      expect(reflected(unlit.off, unlit.on), "an unlit surface never reflects").toBe(0);
      expect(pixelDifference(unlit.off, unlit.on), "unlit color is unchanged").toBeLessThan(0.5);
    }
  });
}

// The march reads each light's views of the shadow atlas (its WGSL twin too): the occluder cuts the beam exactly where
// the view's rays cross its shadow, and the fog elsewhere is the unshadowed light's.
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`volumetric shadows cut the beam where the occluder shadows it on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __spatialEffectsProof: typeof runSpatialEffectsProof;
    }).__spatialEffectsProof(backend, "volumetricShadows"), backend).catch(async (error: unknown) => {
      await testInfo.attach("volumetric-shadow-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("volumetric-shadow-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.volumetricShadowCaptures).toHaveLength(1);
    const { off, shadowed, open, beam, aboveFog } = result.volumetricShadowCaptures[0]!;
    const brighter = (a: number[], b: number[], by: number) => a.filter((value, i) => i % 4 === 0 && value > b[i]! + by).length;
    expect(brighter(shadowed, off, 8), "the beam fogs the view").toBeGreaterThan(20);
    // Scene-wide fog thins with height above Fog Height: high above it, the beam is all but gone.
    expect(brighter(aboveFog, off, 8), "fog thins above Fog Height").toBeLessThan(brighter(open, off, 8) / 10);
    /**
     * Pixels whose view ray, and each neighbour's, passes `test`: given how far it runs through the beam's shadow up to
     * the surface and in the march step past it (the march may sample there). Neighbours too, as the march's coarser
     * buffer blends a pixel with them.
     */
    const settled = (test: (shadowed: number, beyond: number) => boolean) => {
      const pixels: number[] = [];
      for (let row = 2; row < beam.height - 2; row++)
        for (let column = 2; column < beam.width - 2; column++) {
          let all = true;
          for (let dy = -2; dy <= 2 && all; dy++)
            for (let dx = -2; dx <= 2 && all; dx++) {
              const at = (row + dy) * beam.width + column + dx;
              all = test(beam.shadowed[at]!, beam.shadowedBeyond[at]!);
            }
          if (all) pixels.push(row * beam.width + column);
        }
      return pixels;
    };
    const largest = (pixel: number) => Math.max(...[0, 1, 2].map((channel) => Math.abs(shadowed[pixel * 4 + channel]! - open[pixel * 4 + channel]!)));
    // Rays that never enter the shadow, through the lit beam or past it: the same fog with and without the shadow.
    const unshadowed = settled((shadow, beyond) => shadow === 0 && beyond === 0);
    const unshadowedApart = unshadowed.filter((pixel) => largest(pixel) > 1);
    // Rays that run through a metre or more of the shadow: darker than with the shadow off.
    const cut = settled((shadow) => shadow >= 1);
    const cutLit = cut.filter((pixel) => open[pixel * 4]! - shadowed[pixel * 4]! <= 3);
    await testInfo.attach("volumetric-shadow-mask", {
      body: JSON.stringify({ unshadowed: unshadowed.length, unshadowedApart, cut: cut.length, cutLit }), contentType: "application/json",
    });
    expect(unshadowed.length, "rays clear of the shadow").toBeGreaterThan(1000);
    expect(unshadowedApart, "fog clear of the shadow is the unshadowed light's").toEqual([]);
    expect(cut.length, "rays through the shadow").toBeGreaterThan(100);
    expect(cutLit, "the occluder's shadow cuts the beam").toEqual([]);
  });
}
