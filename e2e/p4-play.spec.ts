import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, PLAY_OVERLAY_TIMEOUT_MS, waitForPlayOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";
import {
  EXPECTED_PREVIEW_ACTOR_POSITIONS,
  previewPlacementScene,
} from "./preview-scene-fixture";

test.describe("P4 Play overlay and session report", () => {
  test("overlay Play keeps each authored mesh at its own world position", async ({
    page,
  }) => {
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
    await clickPlayAndWaitForOverlay(page);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = globalThis as unknown as {
              __babylonslatePlayTest?: {
                visuals: () => Array<{
                  visible: boolean;
                  worldMatrixPosition: [number, number, number];
                }>;
              };
            };
            return (host.__babylonslatePlayTest?.visuals() ?? [])
              .filter((visual) => visual.visible)
              .map((visual) => visual.worldMatrixPosition)
              .sort((a, b) => a[0] - b[0]);
          }),
        { timeout: 15_000 },
      )
      .toEqual(expect.arrayContaining(EXPECTED_PREVIEW_ACTOR_POSITIONS));
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
    await expect(page.getByTestId("play-console-open")).toContainText("Console");
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

  test("clean Play skips the save-and-compile dialog", async ({ page }) => {
    await openTestProject(page);
    await openMainScene(page);

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-prepare-dialog")).toHaveCount(0);
    await page.getByTestId("play-stats-toggle").click();
    await expect(page.getByTestId("stats-hud-draws")).toBeVisible();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("stats-hud-draws")
          .getAttribute("data-draws");
        return Number(attr ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);

    await page.getByTestId("play-overlay-close").click();
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
      let previous = { meshes: -2, textures: -2 };
      await expect
        .poll(
          async () => {
            const current = await page.evaluate(() => {
              const host = globalThis as unknown as {
                __babylonslatePlayTest?: {
                  visuals: () => { slotId: number }[];
                  liveObjectCounts: () => {
                    meshes: number;
                    textures: number;
                  } | null;
                };
              };
              const visuals = host.__babylonslatePlayTest?.visuals().length ?? 0;
              const counts = host.__babylonslatePlayTest?.liveObjectCounts() ?? {
                meshes: -1,
                textures: -1,
              };
              return { visuals, ...counts };
            });
            const stable =
              current.visuals >= 4 &&
              current.meshes === previous.meshes &&
              current.textures === previous.textures &&
              current.meshes > 0;
            previous = { meshes: current.meshes, textures: current.textures };
            return stable;
          },
          { timeout: 15_000, intervals: [200, 200, 250] },
        )
        .toBe(true);
      samples.push({ ...previous });
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

  test("Play chrome is labeled, stats stay collapsed, Pause is first-class", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-hud-stick")).toHaveCount(0);
    await expect(page.getByTestId("play-log-tail")).toHaveCount(0);
    await expect(page.getByTestId("stats-hud")).toBeHidden();
    await expect(page.getByTestId("play-overlay-pause")).toBeVisible();
    await expect(page.getByTestId("play-overlay-pause")).toContainText("Pause");
    await expect(page.getByTestId("play-overlay-close")).toContainText("Stop");
    await expect(page.getByTestId("play-console-open")).toContainText("Console");
    await expect(page.getByTestId("play-stats-toggle")).toContainText("Stats");

    const pauseBox = await page.getByTestId("play-overlay-pause").boundingBox();
    const closeBox = await page.getByTestId("play-overlay-close").boundingBox();
    expect(pauseBox, "Pause should be sized").not.toBeNull();
    expect(closeBox, "Stop should be sized").not.toBeNull();
    expect(pauseBox!.height).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);

    await page.getByTestId("play-stats-toggle").click();
    await expect(page.getByTestId("stats-hud")).toBeVisible();
    await expect(page.getByTestId("play-fps")).toBeVisible();

    await page.getByTestId("play-overlay-pause").click();
    await expect(page.getByTestId("play-overlay-pause")).toContainText("Resume");

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });

  test("Play is disabled until a scene tab is open; creating a scene opens it exclusively", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeDisabled();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="scene"]'),
    ).toHaveCount(0);

    await page.getByTestId("content-browser-new-asset").click();
    await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-Scene").click();
    await page.getByTestId("new-asset-name").fill("LevelTwo");
    await page.getByTestId("content-browser-new-asset-create").click();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="scene"]'),
    ).toHaveCount(1);

    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .click();
    await expect(page.getByTestId("play-preview")).toBeEnabled();

    await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="scene"]'),
    ).toHaveCount(1);
    await expect(page.getByTestId("play-preview")).toBeEnabled();
  });

  test("infinite ExecuteJavaScript closes Play and opens the session report", async ({
    page,
  }) => {
    await openTestProject(page);

    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await expect(page.getByTestId("settings-loop-count")).toBeVisible();
    await page.getByTestId("settings-loop-count").fill("50");
    await page.getByTestId("settings-loop-count").blur();
    await page
      .getByTestId("settings-modal")
      .locator('[data-slot="dialog-close"]')
      .click();
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);

    const installed = await page.evaluate(async (graph) => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setMainGraphContent: (g: unknown) => Promise<boolean>;
        };
      };
      if (!host.__babylonslateTest) return false;
      return host.__babylonslateTest.setMainGraphContent(graph);
    }, {
      nodes: [
        {
          id: "tick",
          type: "flow.event.tick",
          position: { x: 40, y: 80 },
          data: {},
        },
        {
          id: "js",
          type: "debug.executeJavaScript",
          position: { x: 320, y: 80 },
          data: {
            inputs: [],
            outputs: [],
            body: "while (true) {}",
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "tick",
          target: "js",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    });
    expect(installed).toBe(true);

    await openMainScene(page);
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("preview-session-report")).toBeVisible({
      timeout: PLAY_OVERLAY_TIMEOUT_MS,
    });
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect(page.getByTestId("session-report-row")).toContainText(
      "Infinite loop detected",
    );
  });

  test("Project Settings author render resolution and a packaged startup scene", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    await expect(page.getByTestId("setting-render-custom")).toBeVisible();
    await expect(page.getByTestId("setting-render-width")).toBeVisible();
    await expect(page.getByTestId("setting-render-height")).toBeVisible();
    await expect(page.getByTestId("setting-render-black-bars")).toBeVisible();
    await page.getByTestId("settings-modal-category-export").click();
    await expect(page.getByTestId("settings-startup-scene")).toBeVisible();
  });
});
