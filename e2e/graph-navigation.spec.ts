import { expect, test, type Locator } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

async function zoom(editor: Locator): Promise<number> {
  return editor.locator(".react-flow__viewport").evaluate((element) =>
    new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
  );
}

test("graph navigation zooms and fits above overlapping nodes @ipad", async ({ page, isMobile }) => {
  await openTestProject(page);
  expect(await page.evaluate(async () => {
    const host = globalThis as unknown as {
      __babylonslateTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> };
    };
    return host.__babylonslateTest.setMainGraphContent({
      nodes: [{ id: "log", type: "debug.log", position: { x: 80, y: 80 }, data: {} }],
      edges: [],
    });
  })).toBe(true);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  const editor = page.getByTestId("graph-editor");
  const island = editor.getByRole("group", { name: "Graph Navigation" });
  const zoomIn = island.getByRole("button", { name: "Zoom In", exact: true });
  const zoomOut = island.getByRole("button", { name: "Zoom Out", exact: true });
  const fit = island.getByRole("button", { name: "Size Graph To Fit" });
  const press = async (button: Locator) => isMobile ? button.tap() : button.click();
  await expect(island).toBeVisible();
  const initialZoom = await zoom(editor);
  await press(zoomIn);
  await expect.poll(() => zoom(editor)).toBeGreaterThan(initialZoom);
  await press(zoomOut);
  await expect.poll(() => zoom(editor)).toBeCloseTo(initialZoom, 4);

  const boxes = await island.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height, text: button.textContent };
  }));
  expect(boxes).toHaveLength(3);
  for (const box of boxes) {
    expect(box.text).toBe("");
    expect(box.width).toBe(isMobile ? 44 : 28);
    expect(box.height).toBe(isMobile ? 44 : 28);
    expect(box.x).toBe(boxes[0]!.x);
  }
  expect(boxes[1]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height);
  expect(boxes[2]!.y).toBeGreaterThanOrEqual(boxes[1]!.y + boxes[1]!.height);

  // Drag the real node over Zoom In, reproducing elevated selected-node stacking.
  const node = editor.locator('.react-flow__node[data-id="log"]');
  const title = node.getByText("Log", { exact: true });
  const nodeBox = (await node.boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  const target = boxes[0]!;
  const start = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + target.x - nodeBox.x, start.y + target.y - nodeBox.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => zoomIn.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const stack = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      buttonOnTop: stack[0] === button || button.contains(stack[0]!),
      nodeUnderneath: stack.some((element) => element.closest('.react-flow__node[data-id="log"]')),
    };
  })).toEqual({ buttonOnTop: true, nodeUnderneath: true });
  await press(zoomIn);
  await expect.poll(() => zoom(editor)).toBeGreaterThan(initialZoom);
  await press(fit);
  await expect.poll(() => zoom(editor)).toBeCloseTo(initialZoom, 4);
  const canvasBox = (await editor.boundingBox())!;
  await expect.poll(async () => {
    const fitted = (await node.boundingBox())!;
    return fitted.x >= canvasBox.x && fitted.y >= canvasBox.y &&
      fitted.x + fitted.width <= canvasBox.x + canvasBox.width &&
      fitted.y + fitted.height <= canvasBox.y + canvasBox.height;
  }).toBe(true);
});
