import { expect, test } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedGraph,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";

test("H10: one Undo restores a deleted graph node and its edge", async ({
  page,
}) => {
  await openTestProject(page);
  const graph: SerializedGraph = {
    nodes: [
      {
        id: "tick",
        type: "flow.event.tick",
        position: { x: 40, y: 80 },
        data: {},
      },
      {
        id: "print",
        type: "debug.print",
        position: { x: 360, y: 80 },
        data: { value: "History control", key: "history", duration: 1 },
      },
    ],
    edges: [
      {
        id: "tick-print",
        source: "tick",
        target: "print",
        sourceHandle: "execOut",
        targetHandle: "execIn",
      },
    ],
  };
  expect(
    await page.evaluate(async (next) => {
      return (
        globalThis as unknown as {
          __babylonslateTest: {
            setMainGraphContent: (graph: SerializedGraph) => Promise<boolean>;
          };
        }
      ).__babylonslateTest.setMainGraphContent(next);
    }, graph),
  ).toBe(true);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  const panel = page.getByTestId("graph-panel");
  const node = panel.locator('.react-flow__node[data-id="print"]');
  const edge = panel.locator('.react-flow__edge[data-id="tick-print"]');
  await expect(node).toBeVisible();
  await expect(edge).toHaveCount(1);
  await node.getByText("Print", { exact: true }).click();
  const deleteNode = panel.getByTestId("graph-delete");
  await expect(deleteNode).toBeEnabled();
  await deleteNode.click();
  await expect(node).toHaveCount(0);
  await expect(edge).toHaveCount(0);

  await page.getByTestId("undo-document").click();
  await expect(node).toBeVisible();
  await expect(edge).toHaveCount(1);
  await expect(page.getByTestId("compilation-error")).toHaveCount(0);

  await page.getByTestId("redo-document").click();
  await expect(node).toHaveCount(0);
  await expect(edge).toHaveCount(0);
  await page.getByTestId("undo-document").click();
  await expect(node).toBeVisible();
  await expect(edge).toHaveCount(1);
});

test("M5: one Undo restores a deleted actor subtree", async ({ page }) => {
  await openTestProject(page);
  await openMainScene(page);
  const scene: SerializedScene = {
    ...createDefaultScene(),
    actors: [
      createActor("parent", "Parent", {
        components: [createMeshComponent("parent-mesh", "box")],
      }),
      createActor("child", "Child", {
        parentId: "parent",
        components: [createMeshComponent("child-mesh", "sphere")],
      }),
      createActor("control", "Control"),
    ],
  };
  expect(
    await page.evaluate(async (next) => {
      return (
        globalThis as unknown as {
          __babylonslateTest: {
            setActiveSceneContent: (scene: SerializedScene) => Promise<boolean>;
          };
        }
      ).__babylonslateTest.setActiveSceneContent(next);
    }, scene),
  ).toBe(true);
  const parent = page.getByTestId("tree-row-actor:parent");
  const child = page.getByTestId("tree-row-actor:child");
  const control = page.getByTestId("tree-row-actor:control");
  await expect(parent).toBeVisible();
  await expect(child).toBeVisible();
  await page.getByTestId("outliner-menu-parent").click();
  await page.getByTestId("outliner-delete-parent").click();
  await expect(parent).toHaveCount(0);
  await expect(child).toHaveCount(0);
  await expect(control).toBeVisible();

  await page.getByTestId("undo-document").click();
  await expect(parent).toBeVisible();
  await expect(child).toBeVisible();
  await expect(control).toBeVisible();
  await page.getByTestId("redo-document").click();
  await expect(parent).toHaveCount(0);
  await expect(child).toHaveCount(0);
  await expect(control).toBeVisible();
});

test("Undo and Focus follow a dirty Scene renamed in the Content Browser", async ({
  page,
}) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "Scene", "RenameProbe");
  await openMainScene(page);
  const scene: SerializedScene = {
    ...createDefaultScene(),
    actors: [createActor("parent", "Parent"), createActor("control", "Control")],
  };
  expect(
    await page.evaluate(async (next) => {
      return (
        globalThis as unknown as {
          __babylonslateTest: {
            setActiveSceneContent: (scene: SerializedScene) => Promise<boolean>;
          };
        }
      ).__babylonslateTest.setActiveSceneContent(next);
    }, scene),
  ).toBe(true);
  const parent = page.getByTestId("tree-row-actor:parent");
  const control = page.getByTestId("tree-row-actor:control");
  await expect(parent).toBeVisible();
  await page.getByTestId("outliner-menu-parent").click();
  await page.getByTestId("outliner-delete-parent").click();
  await expect(parent).toHaveCount(0);
  const focus = page.getByTestId("focus-layout");
  await focus.click();
  await expect(focus).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scene-outliner-panel")).not.toBeVisible();

  await openContentBrowser(page);
  await page.getByTestId("content-browser-search").fill("RenameProbe");
  const tile = page.locator(
    '[data-asset-path="assets/RenameProbe.scene.babasset"]',
  );
  await expect(tile).toBeVisible();
  await tile.click();
  await tile.click({ button: "right" });
  await page.getByTestId("context-menu-item-rename").click();
  await page.getByTestId("content-browser-name-input").fill("Renamed");
  await page.getByTestId("content-browser-name-confirm").click();
  await expect(page.getByTestId("content-browser-name-dialog")).toHaveCount(0);
  await expect(tile).toHaveCount(0);

  // The renamed tab keeps its Focus layout and its unsaved history.
  await openMainScene(page);
  await expect(focus).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scene-outliner-panel")).not.toBeVisible();
  await focus.click();
  await expect(focus).toHaveAttribute("aria-pressed", "false");
  await expect(control).toBeVisible();
  await expect(parent).toHaveCount(0);
  await page.getByTestId("undo-document").click();
  await expect(parent).toBeVisible();
  await expect(control).toBeVisible();
});
