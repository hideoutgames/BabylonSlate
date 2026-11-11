import { expect, test, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedGraph,
  type SerializedScene,
} from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";

type TestHost = typeof globalThis & {
  __hapticTest: {
    setActiveSceneContent(scene: SerializedScene): Promise<boolean>;
    setMainGraphContent(graph: SerializedGraph): Promise<boolean>;
  };
};

const graphNode = (id: string, type: string, data: Record<string, unknown>, x: number, y: number) =>
  ({ id, type, position: { x, y }, data });

async function shot(page: Page, name: string, testInfo: import("@playwright/test").TestInfo) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: "disabled" });
}

test("several selected actors, Class nodes and Material nodes share their Inspector rows and edit each from its own value", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const files = await minimalProjectFiles();
  const material = createDefaultMaterialDocument("Multi");
  material.nodes.push(
    { id: "add1", type: "math.add", position: { x: -700, y: -120 }, properties: { "default:b": [1] } },
    { id: "add2", type: "math.add", position: { x: -700, y: 140 }, properties: { "default:b": [5] } },
  );
  files.set("assets/Multi.material.hasset", await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000031", type: "Material", name: "Multi",
    version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
  }));
  await openMinimalTestProject(page, files);

  // Scene: two actors with different positions and the same Mesh component.
  await openMainScene(page);
  const scene = createDefaultScene();
  scene.actors = [
    createActor("a", "Crate A", { transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [createMeshComponent("a-mesh", "box")] }),
    createActor("b", "Crate B", { transform: { position: [3, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [createMeshComponent("b-mesh", "box")] }),
  ];
  expect(await page.evaluate((next) => (globalThis as TestHost).__hapticTest.setActiveSceneContent(next), scene)).toBe(true);
  const rowA = page.getByTestId("tree-row-actor:a");
  const rowB = page.getByTestId("tree-row-actor:b");
  await rowA.click();
  await rowB.click({ modifiers: ["Control"] });
  const x = page.getByTestId("property-actor-position-x");
  await expect(x).toHaveValue("Mixed Values");
  await expect(page.getByTestId("property-actor-name")).toHaveAttribute("placeholder", "Mixed Values");
  await shot(page, "scene-actors-mixed", testInfo);
  // Each actor moves by 4 from its own X.
  await x.click();
  await x.press("End");
  await x.pressSequentially("+4");
  await x.press("Enter");
  await rowA.click();
  await expect(x).toHaveValue("5");
  await rowB.click();
  await expect(x).toHaveValue("7");

  // Class graph: two Add nodes whose B differs.
  const graph = {
    nodes: [
      graphNode("add1", "math.add", { "default:a": 0, "default:b": 1 }, 0, 0),
      graphNode("add2", "math.add", { "default:a": 0, "default:b": 5 }, 0, 260),
    ],
    edges: [],
  } as unknown as SerializedGraph;
  expect(await page.evaluate((next) => (globalThis as TestHost).__hapticTest.setMainGraphContent(next), graph)).toBe(true);
  await page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByTestId("document-tab-select").click();
  const classNode = (id: string) => page.getByTestId("graph-panel").locator(`.react-flow__node[data-id="${id}"]`);
  await expect(classNode("add2")).toBeVisible({ timeout: 15_000 });
  await classNode("add1").click({ position: { x: 24, y: 10 } });
  await classNode("add2").click({ position: { x: 24, y: 10 }, modifiers: ["Control"] });
  await expect(page.getByText("2 Nodes").filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('input[value="Mixed Values"]').filter({ visible: true }).first()).toBeVisible();
  await shot(page, "class-nodes-mixed", testInfo);

  // Material graph: the same two Add nodes.
  await openAssetFromBrowser(page, "assets/Multi.material.hasset");
  const materialNode = (id: string) => page.getByTestId("material-graph-editor").locator(`.react-flow__node[data-id="${id}"]`);
  await expect(materialNode("add2")).toBeVisible({ timeout: 15_000 });
  await materialNode("add1").click({ position: { x: 24, y: 10 } });
  await materialNode("add2").click({ position: { x: 24, y: 10 }, modifiers: ["Control"] });
  await expect(page.getByText("2 Nodes").filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('input[value="Mixed Values"]').filter({ visible: true }).first()).toBeVisible();
  await shot(page, "material-nodes-mixed", testInfo);
});

test("several selected Prefab components share their Inspector rows", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  // The Empty starter's Mannequin Class holds several components.
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/Mannequin.class.hasset");
  const tree = page.getByTestId("actor-prefab-panel").getByTestId("prefab-tree");
  await expect(tree).toBeVisible({ timeout: 15_000 });
  const rows = tree.locator('[data-testid^="tree-row-"]');
  await expect.poll(() => rows.count()).toBeGreaterThan(2);
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ["Control"] });
  await expect(page.getByTestId("inspector-prefab-multi").filter({ visible: true })).toContainText("2 Components");
  await shot(page, "prefab-components-mixed", testInfo);
});
