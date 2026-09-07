import { expect, test } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const graph: SerializedGraph = {
  nodes: ["Jump", "Fire", "Confirm"].flatMap((action, index) => [
    {
      id: action,
      type: "input.onAction",
      position: { x: 0, y: index * 160 },
      data: { action, phase: "pressed" },
    },
    {
      id: `${action}-print`,
      type: "debug.print",
      position: { x: 360, y: index * 160 },
      data: { value: action, key: action, duration: 1 },
    },
  ]),
  edges: ["Jump", "Fire", "Confirm"].map((action) => ({
    id: `${action}-edge`,
    source: action,
    target: `${action}-print`,
    sourceHandle: "execOut",
    targetHandle: "execIn",
  })),
};

for (const preview of [false, true]) {
  test(`H13: authored keys survive reload and dispatch in ${preview ? "Preview Build" : "Normal Play"}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    expect(
      await page.evaluate(
        async (next) =>
          (
            globalThis as unknown as {
              __babylonslateTest: {
                setMainGraphContent: (
                  value: SerializedGraph,
                ) => Promise<boolean>;
              };
            }
          ).__babylonslateTest.setMainGraphContent(next),
        graph,
      ),
    ).toBe(true);
    await openMainScene(page);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-input").click();
    await page.getByTestId("input-action-0-binding-0-code").click();
    await page.getByTestId("search-item-KeyH").click();
    await page.getByTestId("input-action-0-add-binding").click();
    await page.getByTestId("input-action-0-binding-3-code").click();
    await page.getByTestId("search-item-KeyG").click();
    await page.getByTestId("input-action-add").click();
    await page.getByTestId("input-action-2-name").fill("Fire");
    await page.getByTestId("input-action-2-add-binding").click();
    await page.getByTestId("input-action-2-binding-0-code").click();
    await page.getByTestId("search-item-KeyF").click();
    await page
      .getByTestId("settings-modal")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByTestId("save-all-project").click();
    await expect(page.getByTestId("save-all-project")).toBeDisabled();
    await page.reload();
    await openTestProject(page);
    await openMainScene(page);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-input").click();
    await expect(
      page.getByTestId("input-action-0-binding-0-code"),
    ).toContainText("H");
    await expect(page.getByTestId("input-action-2-name")).toHaveValue("Fire");
    await page
      .getByTestId("settings-modal")
      .getByRole("button", { name: "Close", exact: true })
      .click();

    if (preview) {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    } else {
      await clickPlayAndWaitForOverlay(page);
      await expect(page.getByTestId("play-actor-guids")).toHaveAttribute(
        "data-guids",
        /.+/,
        { timeout: 30_000 },
      );
    }
    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    const canvas = preview
      ? frame.locator("canvas#game")
      : page.getByTestId("play-canvas");
    const prints = preview
      ? frame.getByTestId("print-overlay")
      : page.getByTestId("print-overlay");
    await canvas.click();
    await expect(canvas).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(prints).toContainText("Confirm");
    await page.keyboard.press("Space");
    await page.keyboard.press("f");
    await expect(prints).toContainText("Fire");
    await expect(prints.getByText("Jump", { exact: true })).toHaveCount(0);
    await page.keyboard.press("h");
    await expect(prints).toContainText("Jump");
    await expect(prints.getByText("Jump", { exact: true })).toHaveCount(0);
    await page.keyboard.press("g");
    await expect(prints).toContainText("Jump");
    await page
      .getByTestId(preview ? "preview-build-close" : "play-overlay-close")
      .click();
  });
}

test("H21/M33: native toolbar keyboard activation ends when the canvas regains focus", async ({
  page,
}) => {
  await openTestProject(page);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("play-actor-guids")).toHaveAttribute(
    "data-guids",
    /.+/,
    { timeout: 30_000 },
  );
  const stats = page.getByTestId("play-stats-toggle");
  await stats.click();
  await expect(stats).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(stats).toHaveAttribute("aria-pressed", "false");
  const canvas = page.getByTestId("play-canvas");
  await canvas.click();
  await expect(canvas).toBeFocused();
  await page.keyboard.press("Space");
  await expect(stats).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("play-overlay-close").click();
});
