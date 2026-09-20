import { expect, test } from "@playwright/test";
import type { runBakedPlayerFixture } from "../apps/editor/src/testing/baked-player-fixture";
import { openMinimalTestProject } from "./minimal-project";
import { waitForPreviewBuildBoot } from "./play";

// The fixture hashes real Babylon vertex data, so it is built in the test
// build; the spec only seeds the returned file bytes into OPFS.
test("Preview Build hydrates packed bake assets and shades the receiver with the synthetic atlas", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/?bakedPlayerFixture=1");
  await page.waitForFunction(() => "__bakedPlayerFixture" in window);
  const entries = await page.evaluate(() =>
    (
      window as unknown as { __bakedPlayerFixture: typeof runBakedPlayerFixture }
    ).__bakedPlayerFixture(),
  );
  const files = new Map(
    entries.map(([path, bytes]) => [path, Uint8Array.from(bytes)]),
  );
  await openMinimalTestProject(page, files);
  // Preview Build is a Debug-menu toggle followed by the Play button, same as
  // the P14 specs: the toggle only exists inside the open dropdown.
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  const canvas = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-canvas");
  // The applied bake excludes the white realtime light and adds warm E; an
  // unbaked or stale run renders grey or unlit pixels instead.
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
          let warm = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const r = pixels[offset]!;
            const g = pixels[offset + 1]!;
            const b = pixels[offset + 2]!;
            if (r > 60 && r > g + 40 && r > b + 40) warm += 1;
          }
          return warm;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(100);
  await page.getByTestId("preview-build-close").click();
});
