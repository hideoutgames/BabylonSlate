import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { previewPhysicsScene, previewManyLightsScene } from "./preview-scene-fixture";
import { expectGreenIllumination, expectSpheresRollDownhill, setPreviewScene } from "./preview-parity";

async function previewSlotMaterialNames(page: Page): Promise<string[]> {
  const root = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-root");
  return root.evaluate(() => {
    const host = globalThis as unknown as {
      __babylonslatePlayerTest?: {
        meshMaterialNames?: () => string[];
        visuals: () => Array<{ materialName: string | null }>;
      };
    };
    const named = host.__babylonslatePlayerTest?.meshMaterialNames?.() ?? [];
    if (named.length > 0) return named;
    return (host.__babylonslatePlayerTest?.visuals() ?? [])
      .map((visual) => visual.materialName)
      .filter((name): name is string => typeof name === "string");
  });
}

/**
 * Count slim-stub red and Babylon error-sampler magenta among non-clear pixels.
 * With `texel`, only pixels near that sampled color count as albedo.
 */
async function previewCanvasPixelStats(
  page: Page,
  texel?: readonly [number, number, number],
): Promise<
  | { ok: false; reason: string; width?: number; height?: number }
  | {
      ok: true;
      total: number;
      albedo: number;
      redStub: number;
      magenta: number;
      width: number;
      height: number;
    }
> {
  const canvas = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-canvas");
  return canvas.evaluate((node, texel) => {
    if (!(node instanceof HTMLCanvasElement)) {
      return { ok: false as const, reason: "no-canvas" };
    }
    const width = node.width;
    const height = node.height;
    if (width < 2 || height < 2) {
      return { ok: false as const, reason: "tiny", width, height };
    }
    const dst = document.createElement("canvas");
    dst.width = width;
    dst.height = height;
    const ctx = dst.getContext("2d");
    if (!ctx) return { ok: false as const, reason: "2d" };
    ctx.drawImage(node, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    let albedo = 0;
    let redStub = 0;
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a < 8 || r + g + b < 24) continue;
      // Default Empty sky is blue; do not let it drown a small red character.
      if (b > 90 && b > r + 15 && b > g) continue;
      if (r > 200 && g < 40 && b < 40) {
        redStub += 1;
        continue;
      }
      if (r > 200 && g < 40 && b > 200) {
        magenta += 1;
        continue;
      }
      if (texel) {
        if (Math.abs(r - texel[0]) < 45 && Math.abs(g - texel[1]) < 45 && Math.abs(b - texel[2]) < 45) {
          albedo += 1;
        }
        continue;
      }
      // Kenney albedo is tan/cloth (green channel present). Error-sampler
      // checkerboard is red/black/magenta; grey AA must not count as success.
      if (g >= 50 && r >= 40) {
        albedo += 1;
      }
    }
    const total = albedo + redStub + magenta;
    return { ok: true as const, total, albedo, redStub, magenta, width, height };
  }, texel);
}

test.describe("P14 Preview Build", () => {
  test("Preview Build rolls all eight legacy duplicated spheres down an angled cube", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await setPreviewScene(page, previewPhysicsScene());
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expectSpheresRollDownhill(root);
    await page.getByTestId("preview-build-close").click();
  });

  test("lights beyond the fourth illuminate Scene Viewport, Play, and Preview Build", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await setPreviewScene(page, previewManyLightsScene());
    await expectGreenIllumination(page.getByTestId("viewport-canvas"));
    await clickPlayAndWaitForOverlay(page);
    await expectGreenIllumination(page.getByTestId("play-canvas"));
    await page.getByTestId("play-overlay-close").click();
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    await waitForPreviewBuildBoot(page);
    await expectGreenIllumination(page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas"));
    await page.getByTestId("preview-build-close").click();
  });

  test("Preview Build Play from Scene packs the open tab; off packs startup", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await createContentBrowserAsset(page, "Scene", "LevelTwo");
    const guids = await page.evaluate(() => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          guidForPath: (path: string) => string | null;
          projectStartupSceneGuid: () => string;
        };
      };
      return {
        open:
          host.__babylonslateTest?.guidForPath(
            "assets/LevelTwo.scene.babasset",
          ) ?? "",
        startup: host.__babylonslateTest?.projectStartupSceneGuid() ?? "",
      };
    });
    expect(guids.open).not.toBe(guids.startup);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expect(root).toHaveAttribute("data-startup-scene", guids.open, {
      timeout: 30_000,
    });
    await page.getByTestId("preview-build-close").click();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);

    await page.getByTestId("debug-menu").click();
    await page.getByTestId("play-from-scene-toggle").click();
    await page.getByTestId("play-preview").click();
    const startupRoot = await waitForPreviewBuildBoot(page);
    await expect(startupRoot).toHaveAttribute("data-startup-scene", guids.startup, {
      timeout: 30_000,
    });
    await page.getByTestId("preview-build-close").click();
  });

  test("Preview Build binds the template PBR Mannequin material without the error sampler", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const root = await waitForPreviewBuildBoot(page);
    await expect
      .poll(async () => Number((await root.getAttribute("data-ticks")) ?? "0"), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const names = await previewSlotMaterialNames(page);
          // Basic 3D explicitly assigns its authored PBR graph material.
          return names.some((name) => name.startsWith("material:"))
            ? "bound"
            : names.join(",") || "none";
        },
        { timeout: 30_000 },
      )
      .toBe("bound");

    await expect
      .poll(
        async () => {
          const stats = await previewCanvasPixelStats(page);
          if (!stats.ok || stats.total < 50) {
            return `wait:${JSON.stringify(stats)}`;
          }
          const bad = stats.redStub + stats.magenta;
          return stats.albedo > bad && bad / stats.total < 0.25
            ? "ok"
            : `albedo:${stats.albedo}/red:${stats.redStub}/magenta:${stats.magenta}/total:${stats.total}`;
        },
        { timeout: 30_000 },
      )
      .toBe("ok");
    await page.getByTestId("preview-build-close").click();
  });
});
