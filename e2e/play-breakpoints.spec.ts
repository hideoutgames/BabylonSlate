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
import { acceptUnsavedPlayPrompts } from "./unsaved-play";

type TestHost = typeof globalThis & {
  __hapticPlayTest: { tickIndex(): number };
  __hapticTest: { setMainGraphContent(graph: SerializedGraph): Promise<boolean>; editorQuiet(): boolean };
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
const editorQuiet = (page: Page) => page.evaluate(() => (globalThis as TestHost).__hapticTest.editorQuiet());

test("a breakpoint stops editor Play behind the editor at the node, and Resume returns to the game", async ({ page }) => {
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

  await acceptUnsavedPlayPrompts(page);
  await page.getByTestId("play-preview").click();
  // The first tick stops: the game pauses and hides, and the editor opens the graph at the node.
  const overlay = page.getByTestId("play-overlay");
  await expect(overlay).toHaveAttribute("data-play-break", "", { timeout: 60_000 });
  await expect(overlay).toBeHidden();
  await expect(page.getByTestId("focused-graph-node")).toHaveAttribute("data-node-id", "print");
  await expect(page.getByTestId("play-break-resume")).toBeVisible();
  await expect(page.getByTestId("simulation-breakpoint-stop")).toHaveAttribute("aria-label", "Stopped At main › Event Tick › Print on Hero");
  await expect(page.getByTestId("graph-debug-instance-select")).toContainText("Hero");
  // The editor is back and read-only while Play is stopped.
  expect(await editorQuiet(page)).toBe(false);
  await expect(page.getByTestId("document-authoring-lock-banner").first()).toBeVisible();
  const stoppedAt = await tickIndex(page);
  await page.waitForTimeout(300);
  expect(await tickIndex(page)).toBe(stoppedAt);

  // Breakpoints still change while stopped; Resume returns to the game, which carries on.
  await printNode(page).locator("[data-node-role]").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Disable Breakpoint" }).click();
  await expect(printNode(page).locator('[data-breakpoint="disabled"]')).toHaveCount(1);
  await page.getByTestId("play-break-resume").click();
  await expect(overlay).toBeVisible();
  await expect(overlay).not.toHaveAttribute("data-play-break");
  await expect.poll(() => tickIndex(page), { timeout: 30_000 }).toBeGreaterThan(stoppedAt + 2);
  expect(await editorQuiet(page)).toBe(true);
  await expect(page.getByTestId("play-break-resume")).toHaveCount(0);

  await page.getByTestId("play-overlay-close").click();
  await expect(overlay).toHaveCount(0, { timeout: 30_000 });
});
