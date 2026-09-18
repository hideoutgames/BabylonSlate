import { expect, test } from "@playwright/test";
import { celBandReference } from "../packages/render/src/cel-reference.ts";
import type { runCelRenderModeProof } from "../apps/editor/src/testing/cel-render-mode-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// launchOptions must be applied at file level; Playwright rejects them inside a describe group.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`diffuse bands, highlights and the cast-shadow edge are single-step on ${backend}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        ["error", "warning"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text())
      )
        errors.push(message.text());
    });
    await page.goto("/?test=1&celRenderModeProof=1");
    await page.waitForFunction(
      () =>
        typeof (
          window as unknown as {
            __babylonslateCelRenderModeProof?: unknown;
          }
        ).__babylonslateCelRenderModeProof === "function",
    );
    const result = await page.evaluate(
      (backend) =>
        (
          window as unknown as {
            __babylonslateCelRenderModeProof: typeof runCelRenderModeProof;
          }
        ).__babylonslateCelRenderModeProof(backend),
      backend,
    );
    await testInfo.attach("cel-hard-steps", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);

    const { bands, midpoint, specularStrength, baseGreen } = result.config;
    // The highlight adds one whole specularStrength quantum per light; the
    // tint keeps the material's dominant channel at full strength.
    const quantum = Math.round(specularStrength * 255);
    // (a) Diffuse luminance is exactly the reference band levels.
    const diffuseLevels = new Set<number>();
    for (let i = 0; i <= 512; i++)
      diffuseLevels.add(
        Math.round(baseGreen * celBandReference(i / 512, bands, midpoint)),
      );
    const levels = [...diffuseLevels].sort((a, b) => a - b);
    expect(levels.length).toBeLessThanOrEqual(bands);
    for (const lightMixing of ["strongest", "additive", "blend"] as const) {
      const row = result.mixing[lightMixing]!.row;
      const distinct = [
        ...new Set(row.filter((_, i) => i % 4 === 1)),
      ].sort((a, b) => a - b);
      // (b) Every pixel is a band level or a whole-quantum highlight above
      // one; additive may stack whole highlights from distinct lights.
      const quanta = lightMixing === "additive" ? [0, 1, 2] : [0, 1];
      for (const value of distinct) {
        const onStep = levels.some((level) =>
          quanta.some((k) => Math.abs(value - (level + k * quantum)) <= 1),
        );
        expect(
          onStep,
          `${lightMixing} luminance ${value} outside ${JSON.stringify(levels)} + ${quantum}·k`,
        ).toBe(true);
      }
      const highlights = distinct.filter((value) =>
        levels.every((level) => Math.abs(value - level) > 1),
      );
      expect(
        highlights.length,
        `${lightMixing} produced no highlight pixels`,
      ).toBeGreaterThan(0);
      if (lightMixing === "additive")
        expect(
          highlights.some(
            (value) =>
              levels.some(
                (level) => Math.abs(value - (level + 2 * quantum)) <= 1,
              ) ||
              // The lights' highlights overlap on the top band: level + 2·q
              // exceeds 255 and clamps, which a single quantum (≤254) cannot
              // reach — saturation still proves stacking.
              value >= 255,
          ),
          "additive did not stack two whole highlight quanta",
        ).toBe(true);
      else
        expect(
          highlights.every((value) =>
            levels.some(
              (level) => Math.abs(value - (level + quantum)) <= 1,
            ),
          ),
          `${lightMixing} highlight ${JSON.stringify(highlights)} is not exactly one quantum`,
        ).toBe(true);
    }

    // (c) The cast-shadow edge steps between two luminance levels with no
    // filtered intermediate pixel.
    const shadow = result.shadow;
    expect(shadow, "no row crossed the cast shadow").not.toBeNull();
    expect(shadow!.litLevel - shadow!.darkLevel).toBeGreaterThanOrEqual(30);
    expect(shadow!.lit).toBeGreaterThan(30);
    expect(shadow!.dark).toBeGreaterThan(5);
    expect(
      shadow!.other,
      `row ${shadow!.y} has ${shadow!.other} pixels between lit (${shadow!.litLevel}) and shadowed (${shadow!.darkLevel}) luminance`,
    ).toBeLessThanOrEqual(2);
  });
}
