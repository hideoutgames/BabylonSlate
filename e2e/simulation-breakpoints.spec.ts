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
  __hapticPlayTest: { tickIndex(): number };
  __hapticTest: { setMainGraphContent(graph: SerializedGraph): Promise<boolean> };
};

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0) =>
  ({ id, type, position: { x, y }, data });

/** Event Tick prints every tick. */
const CLASS_GRAPH = {
  nodes: [
    node("tick", "flow.event.tick", {}, 0, 0),
    node("print", "debug.print", { "default:key": "tick", "default:duration": 0.1 }, 420, 0),
  ],
  edges: [{ id: "tick.execOut>print.execIn", source: "tick", sourceHandle: "execOut", target: "print", targetHandle: "execIn" }],
} as unknown as SerializedGraph;

const graphPanel = (page: Page) => page.getByTestId("graph-panel");
const printNode = (page: Page) => graphPanel(page).locator('.react-flow__node[data-id="print"]');
const tickIndex = (page: Page) => page.evaluate(() => (globalThis as TestHost).__hapticPlayTest.tickIndex());
/** Canvas nodes whose run highlight is held (a paused Web Animation on the node shell). */
const heldNodes = (page: Page) => page.evaluate(() => document.getAnimations()
  .filter((animation) => animation.playState === "paused")
  .map((animation) => (animation.effect as KeyframeEffect | null)?.target)
  .filter((target): target is Element => target instanceof Element && target.matches("[data-node-role]"))
  .map((target) => target.closest(".react-flow__node")?.getAttribute("data-id"))
  .filter((id): id is string => !!id)
  .sort());

test("a breakpoint set from a node's menu stops a Simulation, opens the node and names the stop", async ({ page }) => {
  test.setTimeout(240_000);
  await openMinimalTestProject(page);
  await openMainScene(page);
  expect(await page.evaluate((graph) => (globalThis as TestHost).__hapticTest.setMainGraphContent(graph), CLASS_GRAPH)).toBe(true);
  const scene = createDefaultScene();
  scene.actors = [
    ...scene.actors.filter((actor) => actor.classId !== "main"),
    createActor("hero", "Hero", {
      classId: "main",
      transform: identitySerializedTransform(),
      components: [createMeshComponent("hero-mesh", "box")],
    }),
  ];
  await setPreviewScene(page, scene);

  await page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByTestId("document-tab-select").click();
  await expect(printNode(page)).toBeVisible({ timeout: 15_000 });
  await printNode(page).locator("[data-node-role]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Breakpoint" }).click();
  await expect(printNode(page).locator('[data-breakpoint="enabled"]')).toHaveCount(1);

  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  // The first tick stops: the Simulation pauses (Step appears) and the Class graph opens at the node.
  await expect(page.getByTestId("simulation-step")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("focused-graph-node")).toHaveAttribute("data-node-id", "print");
  await expect(printNode(page)).toBeVisible();
  const stoppedAt = await tickIndex(page);
  await page.waitForTimeout(300);
  expect(await tickIndex(page)).toBe(stoppedAt);
  // The toolbar names the stop as the canvas titles its node, and Debug Instance follows the object that reached it.
  await expect(printNode(page)).toContainText("Print");
  await expect(page.getByTestId("simulation-breakpoint-stop")).toHaveAttribute("aria-label", "Stopped At main › Event Tick › Print on Hero");
  await expect(page.getByTestId("graph-debug-instance-select")).toContainText("Hero");
  // The object's path shows from its next tick on (a Step stops at the node again) and stays lit while paused.
  await page.getByTestId("simulation-step").click();
  await expect.poll(() => heldNodes(page), { timeout: 15_000 }).toEqual(["print", "tick"]);

  // Switched off while the Simulation runs, it no longer stops it.
  await printNode(page).locator("[data-node-role]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Disable Breakpoint" }).click();
  await expect(printNode(page).locator('[data-breakpoint="disabled"]')).toHaveCount(1);
  await page.getByTestId("simulation-pause").click();
  await expect.poll(() => tickIndex(page), { timeout: 30_000 }).toBeGreaterThan(stoppedAt + 2);
  await expect(page.getByTestId("simulation-step")).toHaveCount(0);
  await expect(page.getByTestId("simulation-breakpoint-stop")).toHaveCount(0);
});

/** Event Tick runs Do N, whose Counter output counts its earlier runs (0, 1, 2, ...), then prints. */
const COUNTER_GRAPH = {
  nodes: [
    node("tick", "flow.event.tick", {}, 0, 0),
    node("count", "flow.doN", { "default:n": 100 }, 320, 0),
    node("print", "debug.print", { "default:key": "tick", "default:duration": 0.1 }, 640, 0),
  ],
  edges: [
    { id: "tick.execOut>count.execIn", source: "tick", sourceHandle: "execOut", target: "count", targetHandle: "execIn" },
    { id: "count.then>print.execIn", source: "count", sourceHandle: "then", target: "print", targetHandle: "execIn" },
  ],
} as unknown as SerializedGraph;

test("a breakpoint's condition and hit count decide which run stops a Simulation", async ({ page }) => {
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

  await page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByTestId("document-tab-select").click();
  const countNode = graphPanel(page).locator('.react-flow__node[data-id="count"]');
  await expect(countNode).toBeVisible({ timeout: 15_000 });
  await countNode.locator("[data-node-role]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Breakpoint" }).click();
  await countNode.locator("[data-node-role]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Breakpoint…" }).click();

  // Counter ≥ 2, second time: the runs counting 2 and 3 meet it, so the fourth tick stops.
  const dialog = page.getByTestId("breakpoint-settings-dialog");
  await dialog.getByLabel("Condition").click();
  await page.getByRole("option", { name: "Counter" }).click();
  await dialog.getByLabel("Comparison").click();
  await page.getByRole("option", { name: "≥" }).click();
  await dialog.getByLabel("Value").fill("2");
  await dialog.getByRole("checkbox", { name: "Stop Only On Hit" }).click();
  await dialog.getByLabel("Hit Count").fill("2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);

  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await expect(page.getByTestId("simulation-step")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("simulation-breakpoint-stop")).toHaveAttribute("aria-label", "Stopped At main › Event Tick › Do N on Hero");
  const stoppedAt = await tickIndex(page);
  expect(stoppedAt).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(300);
  expect(await tickIndex(page)).toBe(stoppedAt);
});
