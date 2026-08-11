import { expect, test } from "@playwright/test";

async function openTestProject(page: import("@playwright/test").Page) {
  await page.goto("/?test=1&previewThrow=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project-empty").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

test.describe("P4 Play overlay and session report", () => {
  test("Play opens overlay; fixture throw shows report and focuses node", async ({
    page,
  }) => {
    await openTestProject(page);

    await page.locator('[data-asset-path="assets/main.scene.babasset"]').click();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(
      page.getByTestId("document-workspace-scene").locator("canvas"),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-canvas")).toBeVisible();

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("preview-session-report")).toBeVisible();
    // Output log records runtime mode + texture counts from Play stop.
    await expect(page.getByTestId("output-log-panel")).toContainText(
      /Play ended \((worker|in-process)/,
    );
    await page.getByTestId("session-report-row").click();
    await expect(page.getByTestId("focused-graph-node")).toHaveAttribute(
      "data-node-id",
      "throw-node",
    );
  });
});
