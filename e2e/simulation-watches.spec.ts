import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedGraph,
} from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";

type TestHost = typeof globalThis & {
  __hapticSimulationTest: { start(): Promise<void> };
  __hapticTest: { setMainGraphContent(graph: SerializedGraph): Promise<boolean> };
};

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0) =>
  ({ id, type, position: { x, y }, data });

/** Event Tick runs Do N, whose Counter output counts its earlier runs; the Class has a `gold` variable of 5. */
const COUNTER_GRAPH = {
  nodes: [
    node("tick", "flow.event.tick", {}, 0, 0),
    node("count", "flow.doN", { "default:n": 1000 }, 320, 0),
  ],
  edges: [{ id: "tick.execOut>count.execIn", source: "tick", sourceHandle: "execOut", target: "count", targetHandle: "execIn" }],
  members: [{ id: "var-gold", kind: "variable", name: "gold", typeId: "int", defaultValue: 5 }],
} as unknown as SerializedGraph;

const graphPanel = (page: Page) => page.getByTestId("graph-panel");
const watchValue = (page: Page, name: string) =>
  page.getByTestId("watch-row").filter({ hasText: name }).getByTestId("watch-value");

test("watches show the followed object's pin and variable values in a Simulation and update after a Step", async ({ page }) => {
  test.setTimeout(240_000);
  await openMinimalTestProject(page);
  await openMainScene(page);
  expect(await page.evaluate((graph) => (globalThis as TestHost).__hapticTest.setMainGraphContent(graph), COUNTER_GRAPH)).toBe(true);
  const scene = createDefaultScene();
  scene.actors = [
    ...scene.actors.filter((actor) => actor.classId !== "main"),
    createActor("hero", "Hero", { classId: "main", transform: identitySerializedTransform(), components: [createMeshComponent("hero-mesh", "box")] }),
  ];
  await setPreviewScene(page, scene);

  const classTab = page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByTestId("document-tab-select");
  await classTab.click();
  const countNode = graphPanel(page).locator('.react-flow__node[data-id="count"]');
  await expect(countNode).toBeVisible({ timeout: 15_000 });
  await countNode.locator("[data-node-role]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Watch Pin" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Counter" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("treeitem", { name: /gold/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Watch" }).click();

  await page.getByTestId("windows-menu").click();
  await page.getByTestId("windows-menu-watches").click({ force: true });
  await expect(page.getByTestId("watch-row")).toHaveCount(2);
  await expect(watchValue(page, "Counter")).toHaveText("Not Debugged");

  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await classTab.click();
  await expect(watchValue(page, "gold")).toHaveText("5", { timeout: 30_000 });
  await expect(watchValue(page, "Counter")).toHaveText(/^\d+$/, { timeout: 30_000 });

  // Paused, the values hold; a Step runs one more tick and the counter moves on by one.
  await page.getByTestId("simulation-pause").click();
  await expect(page.getByTestId("simulation-step")).toBeVisible();
  const held = Number(await watchValue(page, "Counter").textContent());
  await page.waitForTimeout(300);
  await expect(watchValue(page, "Counter")).toHaveText(String(held));
  await page.getByTestId("simulation-step").click();
  await expect(watchValue(page, "Counter")).toHaveText(String(held + 1), { timeout: 15_000 });
  await expect(watchValue(page, "gold")).toHaveText("5");
});
