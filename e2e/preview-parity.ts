import { expect, type Locator, type Page } from "@playwright/test";
import type { SerializedScene } from "../packages/core/src/index.ts";
import { saveAllIfEnabled } from "./save-all";

export async function setPreviewScene(page: Page, scene: SerializedScene) {
  expect(
    await page.evaluate(async (nextScene) => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setActiveSceneContent: (scene: typeof nextScene) => Promise<boolean>;
        };
      };
      return host.__babylonslateTest?.setActiveSceneContent(nextScene) ?? false;
    }, scene),
  ).toBe(true);
  await saveAllIfEnabled(page);
}

/** A free-falling or AABB-stopped sphere cannot travel downhill along the ramp. */
export async function expectSpheresRollDownhill(root: Locator) {
  await expect
    .poll(
      () =>
        root.evaluate(() => {
          type Visual = { visible: boolean; position: number[] };
          const host = globalThis as unknown as {
            __babylonslatePlayTest?: { visuals: () => Visual[] };
            __babylonslatePlayerTest?: { visuals: () => Visual[] };
          };
          const api =
            host.__babylonslatePlayTest ?? host.__babylonslatePlayerTest;
          const visuals = api?.visuals() ?? [];
          // Each sphere has its own lane; sky, light, and ramp stay at z=0.
          return [-10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5].filter((z) =>
            visuals.some(
              (visual) =>
                visual.visible &&
                Math.abs(visual.position[2]! - z) < 0.25 &&
                visual.position[0]! > -3 &&
                visual.position[1]! > -10,
            ),
          ).length;
        }),
      { timeout: 30_000, intervals: [100, 200, 500] },
    )
    .toBe(8);
}

/** Read the rendered canvas rather than merely counting authored light objects. */
export async function expectGreenIllumination(canvas: Locator) {
  await expect
    .poll(
      () =>
        canvas.evaluate((node) => {
          if (!(node instanceof HTMLCanvasElement)) return 0;
          const copy = document.createElement("canvas");
          copy.width = node.width;
          copy.height = node.height;
          const context = copy.getContext("2d");
          if (!context) return 0;
          context.drawImage(node, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            copy.width,
            copy.height,
          ).data;
          let green = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const r = pixels[offset]!;
            const g = pixels[offset + 1]!;
            const b = pixels[offset + 2]!;
            if (g > 60 && g > r * 1.5 && g > b * 1.5) green += 1;
          }
          return green;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(500);
}
