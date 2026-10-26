import { expect, test, type Page } from "@playwright/test";
import type { SerializedScene } from "../packages/core/src/scene";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene, waitForSceneViewportReady } from "./open-test-project";

const HUD_ITEM_FILE = "assets/HudItem.class.hasset";

async function selectMode(page: Page, label: string) {
  await page.getByTestId("scene-mode-select").click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByTestId("scene-mode-select")).toContainText(label);
}

async function sceneContent(page: Page): Promise<SerializedScene> {
  return page.evaluate(() => (globalThis as unknown as { __hapticTest: { activeSceneContent(): SerializedScene } }).__hapticTest.activeSceneContent());
}

async function addPaletteRow(page: Page, search: string, rowId: string) {
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill(search);
  await page.getByTestId(`node-palette-item-${rowId}`).click();
}

/** The minimal project plus a SceneLayerActor Class that never authored components. */
async function projectWithHudItem() {
  const files = await minimalProjectFiles();
  files.set(HUD_ITEM_FILE, await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000003",
    type: "Class",
    name: "HudItem",
    version: createDefaultMigrationRegistry().currentVersion("Class"),
    payload: { nodes: [], edges: [], members: [] },
  }, { parentClass: "SceneLayerActor" }));
  return files;
}

test.describe("Scene scripts", () => {
  test("edits a Scene's own script in Script mode with Get rows for its actors", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await openMinimalTestProject(page);
    await openMainScene(page);
    await selectMode(page, "Script");
    const graph = page.getByTestId("graph-panel");
    await expect(graph).toBeVisible();
    await expect(page.getByTestId("viewport-panel-frame")).toHaveCount(0);
    await expect(page.getByTestId("my-class-panel")).toContainText("Main Scene Script");
    await expect(graph.getByText("Event Begin Play", { exact: true })).toBeVisible();

    await addPaletteRow(page, "Get Actor", "scene.getOwnedActor:actor-1");
    await addPaletteRow(page, "Get Mesh (Actor)", "scene.getOwnedComponent:actor-1:mesh-1");
    await expect(graph.getByText("Get Actor", { exact: true })).toBeVisible();
    await expect(graph.getByText("Get Mesh (Actor)", { exact: true })).toBeVisible();
    const script = (await sceneContent(page)).script;
    expect(script?.nodes.map((node) => node.type)).toEqual(expect.arrayContaining(["scene.getOwnedActor", "scene.getOwnedComponent"]));
    expect(script?.components).toBeUndefined();
    await page.getByTestId("document-workspace-scene").screenshot({ path: testInfo.outputPath("scene-script-mode.png") });

    // Undo goes through the Scene's own history; Design brings the viewport back.
    await page.getByTestId("undo-document").click();
    await expect(graph.getByText("Get Mesh (Actor)", { exact: true })).toHaveCount(0);
    await selectMode(page, "Design");
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("graph-panel")).toHaveCount(0);
  });

  test("gives a SceneLayerActor Prefab no starter box, a fixed Root and a Frame menu", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await openMinimalTestProject(page, await projectWithHudItem());
    await openAssetFromBrowser(page, HUD_ITEM_FILE);
    await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
    await expect(page.getByTestId("prefab-viewport-panel")).toBeVisible();
    // Only the Prefab Root: no starter Box component.
    await expect(page.getByTestId("actor-prefab-panel").getByRole("treeitem")).toHaveCount(1);

    const frame = page.getByTestId("prefab-frame");
    await expect(frame).toHaveAccessibleName("Frame: Fullscreen");
    await frame.click();
    await page.getByTestId("prefab-frame-size-custom").click();
    await page.keyboard.press("Escape");
    await expect(frame).toHaveAccessibleName("Frame: Custom");
    const width = page.getByTestId("prefab-frame-custom-width");
    await width.fill("640");
    await width.press("Enter");
    await expect(width).toHaveValue(/640/);
    await page.getByTestId("prefab-viewport-panel").screenshot({ path: testInfo.outputPath("scene-layer-actor-frame.png") });

    await page.getByTestId("undo-document").click();
    await expect(page.getByTestId("prefab-frame-custom-width")).not.toHaveValue(/640/);
    await page.getByTestId("undo-document").click();
    await expect(frame).toHaveAccessibleName("Frame: Fullscreen");
  });
});
