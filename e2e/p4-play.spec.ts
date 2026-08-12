import { expect, test } from "@playwright/test";
import { openTestProject } from "./open-test-project";

test.describe("P4 Play overlay and session report", () => {
  test("Play opens overlay; fixture throw shows report and focuses node", async ({
    page,
  }) => {
    await openTestProject(page, "/?test=1&previewThrow=1");

    await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(
      page.getByTestId("document-workspace-scene").locator("canvas"),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await expect(page.getByTestId("play-frame-cap")).toHaveCount(0);

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
});
