import { expect, test } from "@playwright/test";
import type { runWaterTemplateProof } from "../apps/editor/src/testing/water-template-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/**
 * How far built-in water's graph Material may draw from its plugin, per scenario: the mean, over the pixels either
 * water covers, of each pixel's largest channel difference, and the 95th percentile of it (0 to 255). Measured on both
 * backends, with headroom; tightened as the remaining differences close. Both fog by one rule (Babylon PBR's), so fog
 * keeps the tightest bound.
 */
type Scenario = Awaited<ReturnType<typeof runWaterTemplateProof>>["captures"][number]["scenario"];
const BOUNDS: Record<Scenario, { mean: number; p95: number }> = {
  sun: { mean: 4, p95: 6 },
  deep: { mean: 8, p95: 12 },
  grazing: { mean: 5, p95: 8 },
  glint: { mean: 5, p95: 8 },
  fog: { mean: 4, p95: 6 },
  environment: { mean: 4, p95: 6 },
};

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Built-in water's graph Material draws as its plugin does, on ${backend}`, async ({ page }, testInfo) => {
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
    expect(errors).toEqual([]);
    const report: Record<string, unknown> = {};
    for (const scenario of Object.keys(BOUNDS) as Scenario[]) {
      const capture = (water: string) => result.captures.find((entry) => entry.scenario === scenario && entry.water === water)!;
      const none = capture("none").pixels, builtIn = capture("builtIn"), graph = capture("graph");
      expect([builtIn.material, graph.material], scenario).toEqual(["PBRMaterial", "NodeMaterial"]);
      // Where each water drew: the frame without water changed there.
      const wet = (pixels: number[], index: number) =>
        Math.abs(pixels[index]! - none[index]!) + Math.abs(pixels[index + 1]! - none[index + 1]!) + Math.abs(pixels[index + 2]! - none[index + 2]!) > 9;
      let both = 0, either = 0;
      const apart: number[] = [];
      for (let index = 0; index < none.length; index += 4) {
        const plugin = wet(builtIn.pixels, index), template = wet(graph.pixels, index);
        if (plugin && template) both++;
        if (!plugin && !template) continue;
        either++;
        apart.push(Math.max(...[0, 1, 2].map((channel) => Math.abs(graph.pixels[index + channel]! - builtIn.pixels[index + channel]!))));
      }
      apart.sort((a, b) => a - b);
      const mean = apart.reduce((sum, value) => sum + value, 0) / apart.length, p95 = apart[Math.floor(apart.length * 0.95)]!;
      report[scenario] = { covered: either, overlap: both / either, mean, p95 };
      // The water covers most of the frame, the same pixels with either drawing.
      expect(either, scenario).toBeGreaterThan(result.width * result.height / 3);
      expect(both / either, scenario).toBeGreaterThan(0.97);
      expect(mean, scenario).toBeLessThan(BOUNDS[scenario].mean);
      expect(p95, scenario).toBeLessThan(BOUNDS[scenario].p95);
    }
    await testInfo.attach(`water-template-${backend}`, { body: JSON.stringify({ report, result }), contentType: "application/json" });
  });
}
