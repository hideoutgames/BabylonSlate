import { expect, test } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function openMainScene(page: Page) {
  await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
  await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
  await expect(
    page.getByTestId("document-workspace-scene").locator("canvas"),
  ).toBeVisible({ timeout: 15_000 });
}

/** Commit a simulated gizmo drag (mesh mutation → applySceneChange). */
async function commitGizmoNudge(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (
      globalThis as {
        __babylonslateViewportTest: { commitGizmoNudge: () => Promise<boolean> };
      }
    ).__babylonslateViewportTest.commitGizmoNudge(),
  );
}

async function sceneDocumentX(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const position = (
      globalThis as {
        __babylonslateTest: {
          activeSceneActorPosition: () => [number, number, number] | null;
        };
      }
    ).__babylonslateTest.activeSceneActorPosition();
    return position?.[0] ?? null;
  });
}

async function sceneMeshX(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const position = (
      globalThis as {
        __babylonslateViewportTest: {
          activeSceneMeshPosition: () => [number, number, number] | null;
        };
      }
    ).__babylonslateViewportTest.activeSceneMeshPosition();
    return position?.[0] ?? null;
  });
}

async function injectGamepad(
  page: Page,
  pad: { axes: number[]; buttons?: number[] } | null,
): Promise<void> {
  await page.evaluate((next) => {
    (
      globalThis as {
        __babylonslateTest: {
          injectTestGamepad: (
            pad: {
              index?: number;
              axes?: number[];
              buttons?: number[];
            } | null,
          ) => void;
        };
      }
    ).__babylonslateTest.injectTestGamepad(
      next
        ? { index: 0, axes: next.axes, buttons: next.buttons ?? [0, 0, 0, 0] }
        : null,
    );
  }, pad);
}

test.describe("P6 first-playable scene editing", () => {
  test("build, save, reopen, play in 3D and 2D with gamepad and gizmo undo", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);

    await expect(page.getByTestId("viewport-toolbar")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("scene-details-panel")).toBeVisible();

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-shape-box").click();

    const beforeDoc = await sceneDocumentX(page);
    const beforeMesh = await sceneMeshX(page);
    expect(beforeDoc).not.toBeNull();
    expect(beforeMesh).not.toBeNull();
    expect(beforeMesh).toBeCloseTo(beforeDoc ?? 0, 5);

    expect(await commitGizmoNudge(page)).toBe(true);
    await expect
      .poll(async () => sceneDocumentX(page))
      .toBeCloseTo((beforeDoc ?? 0) + 1.5, 5);
    await expect
      .poll(async () => sceneMeshX(page))
      .toBeCloseTo((beforeMesh ?? 0) + 1.5, 5);

    await page.getByTestId("undo-document").click();
    await expect.poll(async () => sceneDocumentX(page)).toBeCloseTo(beforeDoc ?? 0, 5);
    await expect.poll(async () => sceneMeshX(page)).toBeCloseTo(beforeMesh ?? 0, 5);

    await saveAllIfEnabled(page);

    await page.getByTestId("viewport-mode-2d").click();
    await expect(page.getByTestId("viewport-mode-2d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("undo-document").click();
    await expect(page.getByTestId("viewport-mode-3d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("viewport-mode-2d").click();
    await expect(page.getByTestId("viewport-mode-2d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await saveAllIfEnabled(page);

    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("open-listed-project-TestProject.babproject").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await openMainScene(page);
    await expect(page.getByTestId("viewport-mode-2d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await injectGamepad(page, { axes: [0.85, 0, 0, 0] });
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    // Prefer resolved InputResolver Move.x (play-session.lastMoveX) over raw axis.
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("play-move-x")
          .getAttribute("data-move-x");
        return Number(attr ?? "0");
      })
      .toBeGreaterThan(0.5);

    await expect
      .poll(async () => {
        return page.getByTestId("play-actor-guids").getAttribute("data-guids");
      })
      .toContain("actor-1");

    await page.getByTestId("play-overlay-close").click();
    await injectGamepad(page, null);

    await page.getByTestId("viewport-mode-3d").click();
    await expect(page.getByTestId("viewport-mode-3d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
  });

  test("scene panels expose touch-sized toolbar controls", async ({ page }) => {
    await openTestProject(page);
    await openMainScene(page);

    for (const testId of [
      "gizmo-tool-translate",
      "gizmo-tool-rotate",
      "gizmo-tool-scale",
      "gizmo-snap-toggle",
      "gizmo-joystick-toggle",
      "viewport-mode-toggle",
      "outliner-add-actor",
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, testId).not.toBeNull();
      expect(box!.height, testId).toBeGreaterThanOrEqual(28);
      expect(box!.width, testId).toBeGreaterThanOrEqual(28);
    }
  });
});
