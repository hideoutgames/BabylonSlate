import { expect, test } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedGraph,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import {
  openAssetFromBrowser,
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
  await node.click();
  await panel.getByTestId("graph-delete").click();
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
