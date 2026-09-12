import { expect, test } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import {
  openMainScene,
  openTestProject,
  openAssetFromBrowser,
  openContentBrowser,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { guidForPath } from "./material-graph";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const inputGraph = (guids: Record<string, string>): SerializedGraph => ({
  nodes: ["Jump", "Fire", "Confirm"].flatMap((action, index) => [
    {
      id: action,
      type: "input.actionEvent",
      position: { x: 0, y: index * 160 },
      data: {
        "default:binding": { Input: { Name: action, Asset: guids[action] } },
        valueType: "button",
      },
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
    sourceHandle: "started",
    targetHandle: "execIn",
  })),
});

for (const preview of [false, true]) {
  test(`H13: authored keys survive reload and dispatch in ${preview ? "Preview Build" : "Normal Play"}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Input/Jump.inputaction.babasset");
    let bindings = page.getByTestId("document-workspace-input-action");
    await bindings
      .getByRole("button", { name: "Listen", exact: true })
      .first()
      .click();
    await page.keyboard.press("h");
    await bindings.getByRole("button", { name: "Add Control" }).click();
    await page.getByRole("menuitem", { name: "Keyboard", exact: true }).click();
    await bindings
      .getByRole("button", { name: "Listen", exact: true })
      .last()
      .click();
    await page.keyboard.press("g");
    await openContentBrowser(page);
    await selectContentBrowserAssetsFolder(page);
    await page.getByTestId("content-browser-new-asset").click();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-InputAction").click();
    await page.getByTestId("new-asset-name").fill("Fire");
    await page.getByTestId("content-browser-new-asset-create").click();
    await expect(
      page.getByTestId("content-browser-new-asset-dialog"),
    ).toHaveCount(0);
    await openAssetFromBrowser(page, "assets/Fire.inputaction.babasset");
    bindings = page
      .getByTestId("document-workspace-input-action")
      .filter({ visible: true });
    await bindings.getByRole("button", { name: "Add Control" }).click();
    await page.getByRole("menuitem", { name: "Keyboard", exact: true }).click();
    await bindings.getByRole("button", { name: "Listen", exact: true }).click();
    await page.keyboard.press("f");
    const graph = inputGraph({
      Jump: await guidForPath(page, "assets/Input/Jump.inputaction.babasset"),
      Fire: await guidForPath(page, "assets/Fire.inputaction.babasset"),
      Confirm: await guidForPath(
        page,
        "assets/Input/Confirm.inputaction.babasset",
      ),
    });
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
    await page.getByTestId("save-all-project").click();
    await expect(page.getByTestId("save-all-project")).toBeDisabled();
    await page.reload();
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Input/Jump.inputaction.babasset");
    await expect(page.getByTestId("input-control-binding-1")).toContainText(
      "H",
    );
    await openAssetFromBrowser(page, "assets/Fire.inputaction.babasset");
    await expect(
      page
        .getByTestId("document-workspace-input-action")
        .filter({ visible: true })
        .locator('[data-testid^="input-control-"]'),
    ).toContainText("F");
    await openMainScene(page);

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
