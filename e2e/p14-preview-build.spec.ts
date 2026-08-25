import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";
import {
  EXPECTED_PREVIEW_ACTOR_POSITIONS,
  previewPlacementScene,
} from "./preview-scene-fixture";

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

/** Count slim-stub red and Babylon error-sampler magenta among non-clear pixels. */
async function previewCanvasPixelStats(page: Page): Promise<
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
  return canvas.evaluate((node) => {
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
      // Kenney albedo is tan/cloth (green channel present). Error-sampler
      // checkerboard is red/black/magenta; grey AA must not count as success.
      if (g >= 50 && r >= 40) {
        albedo += 1;
      }
    }
    const total = albedo + redStub + magenta;
    return { ok: true as const, total, albedo, redStub, magenta, width, height };
  });
}

test.describe("P14 Preview Build", () => {
  test("default overlay Play is unchanged when Preview Build is off", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await expect(page.getByTestId("play-preview")).toHaveText("Play");
    await page.getByTestId("debug-menu").click();
    await expect(page.getByTestId("preview-build-toggle")).toBeVisible();
    await page.keyboard.press("Escape");
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);
    await page.getByTestId("play-overlay-close").click();
  });

  test("Preview Build Play does not require a scene tab and boots startupSceneGuid", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await expect(page.getByTestId("play-preview")).toHaveText("Preview");
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("preparing-preview-dialog")).toBeVisible();
    await expect(page.getByTestId("preview-build-overlay")).toBeVisible({
      timeout: 30_000,
    });

    const startupGuid = await page.evaluate(async () => {
      const host = globalThis as unknown as {
        __babylonslateTest?: { projectStartupSceneGuid: () => string };
      };
      return host.__babylonslateTest?.projectStartupSceneGuid() ?? "";
    });
    expect(startupGuid.length).toBeGreaterThan(0);

    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    const root = frame.getByTestId("player-root");
    await expect(root).toBeVisible({ timeout: 30_000 });
    // A black overlay used to hide a player that never booted, so assert the
    // packaged game actually started and is drawing.
    await expect(page.getByTestId("preview-build-error")).toHaveCount(0);
    await expect(root).toHaveAttribute("data-startup-scene", startupGuid);
    await expect(root).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
    await expect
      .poll(async () => root.getAttribute("data-ticks"), { timeout: 30_000 })
      .not.toBe("0");
    await expect(root).not.toHaveAttribute("data-error", /.+/);
    const hud = frame.getByTestId("player-hud");
    await expect(hud).toBeVisible();
    await expect
      .poll(async () => Number((await hud.getAttribute("data-fps")) ?? "0"), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    const canvasBox = await frame.getByTestId("player-canvas").boundingBox();
    expect(canvasBox, "player canvas should be laid out").not.toBeNull();
    expect(canvasBox!.width).toBeGreaterThan(0);
    expect(canvasBox!.height).toBeGreaterThan(0);

    const stop = page.getByTestId("preview-build-close");
    await expect(stop).toHaveText("Stop");
    await page.getByTestId("preview-build-close").click();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);
    await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await expect(page.getByTestId("debug-menu")).toBeVisible();
  });

  test("Preview Build preserves authored actor and child world positions", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    const scene = previewPlacementScene();
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

    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    const root = frame.getByTestId("player-root");
    await expect(root).toHaveAttribute("data-booted", "true", {
      timeout: 30_000,
    });
    await expect
      .poll(
        () =>
          root.evaluate(() => {
            const host = globalThis as unknown as {
              __babylonslatePlayerTest?: {
                visuals: () => Array<{
                  visible: boolean;
                  position: [number, number, number];
                }>;
              };
            };
            return (host.__babylonslatePlayerTest?.visuals() ?? [])
              .filter((visual) => visual.visible)
              .map((visual) => visual.position)
              .sort((a, b) => a[0] - b[0]);
          }),
        { timeout: 30_000 },
      )
      .toEqual(EXPECTED_PREVIEW_ACTOR_POSITIONS);
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
    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    const root = frame.getByTestId("player-root");
    await expect(root).toHaveAttribute("data-startup-scene", guids.open, {
      timeout: 30_000,
    });
    await page.getByTestId("preview-build-close").click();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);

    await page.getByTestId("debug-menu").click();
    await page.getByTestId("play-from-scene-toggle").click();
    await page.getByTestId("play-preview").click();
    await expect(root).toHaveAttribute("data-startup-scene", guids.startup, {
      timeout: 30_000,
    });
    await page.getByTestId("preview-build-close").click();
  });

  test("missing startup scene alerts and overlay Play still requires a scene tab when off", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-export").click();
    await page.getByTestId("settings-startup-scene").click();
    await page.getByTestId("search-item-__none__").click();
    await page
      .getByTestId("settings-modal")
      .locator('[data-slot="dialog-close"]')
      .click();
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("startup-scene-alert")).toBeVisible();
    await expect(page.getByTestId("startup-scene-alert")).toContainText(
      "Set Startup Scene in Project Settings.",
    );
    await page.getByTestId("startup-scene-alert-ok").click();
    await expect(page.getByTestId("startup-scene-alert")).toHaveCount(0);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await expect(page.getByTestId("play-preview")).toBeDisabled();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });

  test("Preview Build Main Scene Mannequin is not slim-stub red or the error sampler", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    const root = frame.getByTestId("player-root");
    await expect(root).toHaveAttribute("data-booted", "true", {
      timeout: 30_000,
    });
    await expect
      .poll(async () => Number((await root.getAttribute("data-ticks")) ?? "0"), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const names = await previewSlotMaterialNames(page);
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
