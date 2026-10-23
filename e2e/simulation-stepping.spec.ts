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

/** Each tick visits Event Tick, then Do N, whose Counter output counts its earlier runs. */
const COUNTER_GRAPH = {
  nodes: [
    node("tick", "flow.event.tick", {}, 0, 0),
    node("count", "flow.doN", { "default:n": 100_000 }, 320, 0),
  ],
  edges: [{ id: "tick.execOut>count.execIn", source: "tick", sourceHandle: "execOut", target: "count", targetHandle: "execIn" }],
} as unknown as SerializedGraph;

const graphPanel = (page: Page) => page.getByTestId("graph-panel");
const position = (page: Page) => page.getByTestId("graph-step-position");
const focusedNode = (page: Page) => page.getByTestId("focused-graph-node");
const counterWatch = (page: Page) => page.getByTestId("watch-row").filter({ hasText: "Counter" }).getByTestId("watch-value");
const tickOf = async (page: Page) => Number(/Tick (\d+)/.exec(await position(page).textContent() ?? "")?.[1]);

test("the stepping control walks a paused Simulation's visits both ways, and Forward runs into the next tick", async ({ page }) => {
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
  await page.getByTestId("windows-menu").click();
  await page.getByTestId("windows-menu-watches").click({ force: true });

  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await classTab.click();
  await expect(counterWatch(page)).toHaveText(/^\d+$/, { timeout: 30_000 });
  await page.getByTestId("simulation-pause").click();
  await expect(page.getByTestId("graph-stepping-bar")).toBeVisible();
  await expect(position(page)).toHaveText("Latest Tick");
  const counter = Number(await counterWatch(page).textContent());

  // Back from the live run: the newest visit (Do N), then the one before it (Event Tick), with the counter the
  // previous tick left.
  await page.getByTestId("graph-step-back").click();
  await expect(position(page)).toHaveText(/^Tick \d+ · Step 2 of 2$/);
  const tick = await tickOf(page);
  await expect(focusedNode(page)).toHaveAttribute("data-node-id", "count");
  await expect(counterWatch(page)).toHaveText(String(counter));
  await expect(page.getByTestId("graph-step-past")).toHaveCount(0);
  await page.getByTestId("graph-step-back").click();
  await expect(position(page)).toHaveText(`Tick ${tick} · Step 1 of 2`);
  await expect(focusedNode(page)).toHaveAttribute("data-node-id", "tick");
  await expect(page.getByTestId("graph-step-past")).toBeVisible();
  await expect(counterWatch(page)).toHaveText(String(counter - 1));

  // Forward to the newest visit, then on into a new tick, which runs one tick and stops at its first visit.
  await page.getByTestId("graph-step-forward").click();
  await expect(position(page)).toHaveText(`Tick ${tick} · Step 2 of 2`);
  await expect(counterWatch(page)).toHaveText(String(counter));
  await page.getByTestId("graph-step-forward").click();
  await expect(position(page)).toHaveText(`Tick ${tick + 1} · Step 1 of 2`, { timeout: 15_000 });
  await expect(focusedNode(page)).toHaveAttribute("data-node-id", "tick");
  await expect(counterWatch(page)).toHaveText(String(counter));
  await page.getByTestId("graph-step-forward").click();
  await expect(position(page)).toHaveText(`Tick ${tick + 1} · Step 2 of 2`);
  await expect(counterWatch(page)).toHaveText(String(counter + 1));

  // Resuming leaves the review.
  await page.getByTestId("simulation-pause").click();
  await expect(page.getByTestId("graph-stepping-bar")).toHaveCount(0);
});
