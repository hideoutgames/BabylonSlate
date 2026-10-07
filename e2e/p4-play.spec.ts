import { expect, test } from "@playwright/test";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPlayOverlay } from "./play";
import { previewPhysicsScene } from "./preview-scene-fixture";
import { expectSpheresRollDownhill, setPreviewScene } from "./preview-parity";

test.describe("P4 Play overlay and session report", () => {

  test("Play rolls all eight legacy duplicated spheres down an angled cube", async ({ page }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    await openMainScene(page);
    await setPreviewScene(page, previewPhysicsScene());
    await clickPlayAndWaitForOverlay(page);
    await expectSpheresRollDownhill(page.getByTestId("play-overlay"));
    await page.getByTestId("play-overlay-close").click();
  });

  test("Play opens overlay; fixture throw shows report and focuses node", async ({
    page,
  }) => {
    await openTestProject(page, "/?test=1&previewThrow=1");

    await openMainScene(page);

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await expect(page.getByTestId("play-frame-cap")).toHaveCount(0);
    await expect(page.getByTestId("play-overlay-pause")).toContainText("Pause");
    await expect(page.getByTestId("play-overlay-close")).toContainText("Stop");
    // Debug-menu defaults show only Stats beside Pause and Stop.
    await expect(page.getByTestId("play-stats-toggle")).toContainText("Stats");
    await expect(page.getByTestId("play-console-open")).toHaveCount(0);
    await expect(page.getByTestId("play-inspector-toggle")).toHaveCount(0);
    await expect(page.getByTestId("play-profiler-open")).toHaveCount(0);
    await expect(page.getByTestId("stats-hud")).toBeHidden();

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("preview-session-report")).toBeVisible();
    await expect(page.getByTestId("play-last-runtime")).toHaveAttribute(
      "data-mode",
      /^(worker|in-process)$/,
    );
    await page.getByTestId("session-report-row").click();
    await expect(page.getByTestId("focused-graph-node")).toHaveAttribute(
      "data-node-id",
      "throw-node",
    );
  });

  test("repeated Play cycles keep live mesh and texture counts stable", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    const samples: Array<{ meshes: number; textures: number }> = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await clickPlayAndWaitForOverlay(page);
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const host = globalThis as unknown as {
                __babylonslatePlayTest?: {
                  visuals: () => { slotId: number }[];
                  whenModelsReady: () => Promise<void>;
                  modelLoadCount: () => number;
                  liveObjectCounts: () => {
                    meshes: number;
                    textures: number;
                  } | null;
                };
              };
              const api = host.__babylonslatePlayTest;
              if (!api || api.modelLoadCount() === 0) return false;
              await api.whenModelsReady();
              const visuals = api.visuals().length;
              const counts = api.liveObjectCounts();
              return (
                visuals >= 4 &&
                counts != null &&
                counts.meshes > 0 &&
                counts.textures > 0
              );
            }),
          { timeout: 15_000, intervals: [200, 200, 250] },
        )
        .toBe(true);
      const sample = await page.evaluate(async () => {
        const host = globalThis as unknown as {
          __babylonslatePlayTest?: {
            whenModelsReady: () => Promise<void>;
            liveObjectCounts: () => {
              meshes: number;
              textures: number;
            } | null;
          };
        };
        await host.__babylonslatePlayTest?.whenModelsReady();
        return host.__babylonslatePlayTest?.liveObjectCounts() ?? {
          meshes: -1,
          textures: -1,
        };
      });
      samples.push(sample);
      await page.getByTestId("play-overlay-close").click();
      await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    }
    expect(
      new Set(samples.map((sample) => sample.textures)).size,
      `texture samples ${JSON.stringify(samples)}`,
    ).toBe(1);
    const meshCounts = samples.map((sample) => sample.meshes);
    expect(Math.max(...meshCounts) - Math.min(...meshCounts)).toBeLessThanOrEqual(
      1,
    );
  });

  test("dirty graph Play shows the prepare dialog, then saves", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);

    const nudged = await page.evaluate(async () => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          ensureMainGraphOpen: () => Promise<boolean>;
          nudgeActiveGraphNode: () => Promise<boolean>;
          cancelDebouncedSave: () => void;
        };
      };
      if (!host.__babylonslateTest) return false;
      await host.__babylonslateTest.ensureMainGraphOpen();
      const ok = await host.__babylonslateTest.nudgeActiveGraphNode();
      host.__babylonslateTest.cancelDebouncedSave();
      return ok;
    });
    expect(nudged).toBe(true);

    await expect(page.getByTestId("save-all-project")).toBeEnabled();
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-prepare-dialog")).toBeVisible();
    await waitForPlayOverlay(page);
    await expect(page.getByTestId("play-prepare-dialog")).toHaveCount(0);

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("save-all-project")).toBeDisabled();
  });

  test("Play from Scene boots the open tab; off uses project startup", async ({
    page,
  }) => {
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
    expect(guids.open.length).toBeGreaterThan(0);
    expect(guids.startup.length).toBeGreaterThan(0);
    expect(guids.open).not.toBe(guids.startup);

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-overlay")).toHaveAttribute(
      "data-scene-guid",
      guids.open,
    );
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);

    await page.getByTestId("debug-menu").click();
    await page.getByTestId("play-from-scene-toggle").click();
    await page.keyboard.press("Escape");
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-overlay")).toHaveAttribute(
      "data-scene-guid",
      guids.startup,
    );
    await page.getByTestId("play-overlay-close").click();
  });
});
