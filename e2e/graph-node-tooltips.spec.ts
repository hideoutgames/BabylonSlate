import { expect, test, type Locator } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

const GRAPH_PATH = "assets/Mannequin.class.hasset";

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

test("a node title's tooltip never takes a press, so the node still drags by its title", async ({ page }) => {
  await openTestProject(page);
  const graph: SerializedGraph = {
    nodes: [{ id: "progress", type: "assets.getHandleProgress", position: { x: 80, y: 160 }, data: {} }],
    edges: [],
  };
  const installed = await page.evaluate(async (next) => (
    globalThis as unknown as { __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } }
  ).__hapticTest.setMainGraphContent(next), graph);
  expect(installed).toBe(true);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const node = page.getByTestId("graph-editor").locator('.react-flow__node[data-id="progress"]');
  const title = node.locator("[data-node-title-hint]");
  const tooltip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(title).toHaveText("Get Load Handle Progress");

  const grab = await box(title);
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await expect(tooltip).toHaveText(
    "Returns the load progress from 0 to 1. It never decreases, and reaches 1 only when the Handle is Loaded.",
  );

  // An opening tooltip slides over its label (on a zoomed-out canvas, over all of it), so a press
  // anywhere on the tooltip must reach the canvas under it.
  const tip = await box(tooltip);
  const underTip = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return { onTooltip: Boolean(hit?.closest('[data-slot="tooltip-content"]')), onCanvas: Boolean(hit?.closest(".react-flow")) };
  }, { x: tip.x + tip.width / 2, y: tip.y + tip.height / 2 });
  expect(underTip).toEqual({ onTooltip: false, onCanvas: true });

  // Dragging the node by its title still moves it while the tooltip is showing.
  const start = await box(node);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2 + 120, grab.y + grab.height / 2 + 60, { steps: 12 });
  await page.mouse.up();
  const moved = await box(node);
  // Grid snapping may round the drop; a node that did not move stays at 0.
  expect(moved.x - start.x).toBeGreaterThan(90);
  expect(moved.y - start.y).toBeGreaterThan(30);
});
