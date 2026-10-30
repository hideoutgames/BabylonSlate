import { expect, test } from "@playwright/test";
import type { runWaterTemplateProof } from "../apps/editor/src/testing/water-template-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Result = Awaited<ReturnType<typeof runWaterTemplateProof>>;
type Scenario = Result["captures"][number]["scenario"];

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Built-in water's graph Material draws the lake's look on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterTemplateProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __waterTemplateProof?: unknown }).__waterTemplateProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __waterTemplateProof: typeof runWaterTemplateProof }).__waterTemplateProof(backend), backend);
    await testInfo.attach(`water-template-${backend}`, { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    const { width, height } = result;
    const toLinear = (display: number) => {
      const value = display / 255;
      return !result.exactSrgb ? value ** 2.2 : value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const toDisplay = (linear: number) => {
      const value = Math.min(Math.max(linear, 0), 1);
      return 255 * (!result.exactSrgb ? value ** (1 / 2.2) : value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
    };
    const capture = (scenario: Scenario, water: "none" | "graph") =>
      result.captures.find((entry) => entry.scenario === scenario && entry.water === water)!;
    const rgb = (pixels: number[], pixel: number) => [pixels[pixel * 4]!, pixels[pixel * 4 + 1]!, pixels[pixel * 4 + 2]!];
    /** Pixels on the lake (`distances` ≥ 0) whose 3×3 neighbourhood is too, or off it with every neighbour off it. */
    const settled = (distances: number[], onLake: boolean) => {
      const pixels: number[] = [];
      for (let row = 1; row < height - 1; row++)
        for (let column = 1; column < width - 1; column++) {
          let uniform = true;
          for (let dy = -1; dy <= 1 && uniform; dy++)
            for (let dx = -1; dx <= 1; dx++) if ((distances[(row + dy) * width + column + dx]! >= 0) !== onLake) uniform = false;
          if (uniform) pixels.push(row * width + column);
        }
      return pixels;
    };
    const report: Record<string, unknown> = {};
    const lakes: Partial<Record<Scenario, number[]>> = {};
    for (const scenario of ["sun", "deep", "grazing", "glint", "fog", "environment"] as const) {
      const none = capture(scenario, "none"), water = capture(scenario, "graph");
      expect(water.material, scenario).toBe("NodeMaterial");
      // The water draws over the lake and nowhere else: a pixel changes where the view ray meets the lake.
      const wet = (pixel: number) => Math.max(...rgb(water.pixels, pixel).map((value, channel) => Math.abs(value - none.pixels[pixel * 4 + channel]!))) > 3;
      const lake = settled(result.distances[scenario], true);
      const dry = settled(result.distances[scenario], false);
      lakes[scenario] = lake;
      report[scenario] = { lake: lake.length, dryLake: lake.filter((pixel) => !wet(pixel)).length, dry: dry.length, wetDry: dry.filter(wet).length };
      expect(lake.length, scenario).toBeGreaterThan(width * height / 4);
      expect(lake.filter((pixel) => !wet(pixel)), `${scenario}: the lake draws`).toEqual([]);
      expect(dry.filter(wet), `${scenario}: nothing beside the lake changes`).toEqual([]);
    }
    const mean = (scenario: Scenario, value: (color: number[]) => number) =>
      lakes[scenario]!.reduce((sum, pixel) => sum + value(rgb(capture(scenario, "graph").pixels, pixel)), 0) / lakes[scenario]!.length;
    const luminance = (color: number[]) => 0.2126 * toLinear(color[0]!) + 0.7152 * toLinear(color[1]!) + 0.0722 * toLinear(color[2]!);
    // Shallow water shows its sand floor: deep water is darker and bluer.
    const shallow = { luminance: mean("sun", luminance), warmth: mean("sun", ([r, , b]) => r! - b!) };
    const deep = { luminance: mean("deep", luminance), warmth: mean("deep", ([r, , b]) => r! - b!) };
    // The environment cube (orange above, pale around) warms the reflection.
    const environment = { warmth: mean("environment", ([r, , b]) => r! - b!) };
    // Toward the sun, its glints saturate.
    const glint = lakes.glint!.filter((pixel) => Math.max(...rgb(capture("glint", "graph").pixels, pixel)) >= 250).length;
    const sunGlint = lakes.sun!.filter((pixel) => Math.max(...rgb(capture("sun", "graph").pixels, pixel)) >= 250).length;
    // Fog: each lake pixel is the unfogged lake's (the sun scenario's view) mixed toward the fog colour by Babylon PBR's
    // rule, the linear factor (fog end minus distance over its span) decoded, in linear colour.
    const fogApart = lakes.fog!.map((pixel) => {
      const distance = result.distances.fog[pixel]!;
      const factor = toLinear(255 * Math.min(Math.max((result.fog.end - distance) / (result.fog.end - result.fog.start), 0), 1));
      return Math.max(...rgb(capture("sun", "graph").pixels, pixel).map((value, channel) => {
        const fogged = toDisplay(toLinear(255 * result.fog.color[channel]!) + (toLinear(value) - toLinear(255 * result.fog.color[channel]!)) * factor);
        return Math.abs(capture("fog", "graph").pixels[pixel * 4 + channel]! - fogged);
      }));
    }).sort((a, b) => a - b);
    report.look = {
      shallow, deep, environment, glint, sunGlint,
      fog: { mean: fogApart.reduce((sum, value) => sum + value, 0) / fogApart.length, p95: fogApart[Math.floor(fogApart.length * 0.95)], largest: fogApart.at(-1) },
    };
    await testInfo.attach(`water-template-report-${backend}`, { body: JSON.stringify(report), contentType: "application/json" });
    expect(deep.luminance).toBeLessThan(shallow.luminance * 0.8);
    expect(deep.warmth).toBeLessThan(shallow.warmth - 10);
    expect(environment.warmth).toBeGreaterThan(shallow.warmth + 10);
    expect(glint).toBeGreaterThan(20);
    expect(sunGlint).toBeLessThan(glint / 4);
    expect(fogApart.at(-1)).toBeLessThan(4);
  });
}
