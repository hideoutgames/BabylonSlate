import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

// The knot and the Cut Links hover are checked by eye in these shots, so they are taken at the iPad's pixel ratio.
test.use({ deviceScaleFactor: 2 });

const GRAPH_PATH = "assets/Mannequin.class.hasset";
/** Where the review screenshots go besides the test's own output, when the run names a folder. */
const SHOT_DIR = process.env.HAPTIC_E2E_SHOT_DIR;

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** The screen point halfway along a wire's path. */
async function wireMiddle(editor: Locator, edgeId: string): Promise<{ x: number; y: number }> {
  const path = editor.locator(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`);
  await expect(path).toHaveCount(1);
  return path.evaluate((element: SVGPathElement) => {
    const at = element.getPointAtLength(element.getTotalLength() / 2);
    const matrix = element.getScreenCTM()!;
    return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
  });
}

async function readSavedGraph(page: Page): Promise<SerializedGraph> {
  return page.evaluate(async (path) => {
    const bytes = await (
      globalThis as unknown as {
        __hapticTest: { readAssetChunk: (path: string, chunk: string) => Promise<Uint8Array> };
      }
    ).__hapticTest.readAssetChunk(path, "document");
    return JSON.parse(new TextDecoder().decode(bytes)) as SerializedGraph;
  }, GRAPH_PATH);
}

async function shot(page: Page, editor: Locator, name: string, testInfo: TestInfo) {
  await editor.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: "disabled" });
  if (SHOT_DIR) await editor.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: "disabled" });
}

test("a Class graph wire splits with a Reroute knot, and Cut Links removes wires, pin wires and knots", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  const graph: SerializedGraph = {
    nodes: [
      { id: "begin", type: "flow.event.beginPlay", position: { x: 80, y: 80 }, data: {} },
      { id: "tick", type: "flow.event.tick", position: { x: 80, y: 320 }, data: {} },
      { id: "print", type: "debug.print", position: { x: 760, y: 80 }, data: {} },
    ],
    edges: [
      { id: "x", source: "begin", sourceHandle: "execOut", target: "print", targetHandle: "execIn" },
      { id: "y", source: "tick", sourceHandle: "execOut", target: "print", targetHandle: "execIn" },
    ],
  };
  const installed = await page.evaluate(async (next) => (
    globalThis as unknown as { __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } }
  ).__hapticTest.setMainGraphContent(next), graph);
  expect(installed).toBe(true);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const editor = page.getByTestId("graph-editor");
  const edges = editor.locator(".react-flow__edge");
  const knots = editor.locator('.react-flow__node:has([data-node-kind="reroute"])');
  await expect(editor.locator('.react-flow__node[data-id="print"]')).toBeVisible({ timeout: 15_000 });
  await expect(edges).toHaveCount(2);

  // (a) A double-click on the exec wire splits it with one knot whose pins are exec pins.
  let point = await wireMiddle(editor, "x");
  await page.mouse.dblclick(point.x, point.y);
  await expect(knots).toHaveCount(1);
  await expect(edges).toHaveCount(3);
  await expect(editor.locator('.react-flow__edge[data-id="x"]')).toHaveCount(0);
  let knotId = (await knots.getAttribute("data-id"))!;
  const glyph = (nodeId: string, pinId: string) =>
    editor.locator(`.react-flow__node[data-id="${nodeId}"] [data-handleid="${pinId}"] .graph-pin-visual`)
      .evaluate((element) => ({ shape: element.getAttribute("data-pin-shape"), style: element.getAttribute("style") }));
  // A knot's pins are always round, in the colour of what it carries: here the exec colour of Print's input.
  const knotPin = await glyph(knotId, "in");
  expect(knotPin.shape).toBe("circle");
  expect(knotPin.style).toBe((await glyph("print", "execIn")).style);
  await shot(page, editor, "class-knot", testInfo);

  await page.getByTestId("undo-document").click();
  await expect(knots).toHaveCount(0);
  await expect(editor.locator('.react-flow__edge[data-id="x"]')).toHaveCount(1);
  await expect(edges).toHaveCount(2);

  point = await wireMiddle(editor, "x");
  await page.mouse.dblclick(point.x, point.y);
  await expect(knots).toHaveCount(1);
  knotId = (await knots.getAttribute("data-id"))!;
  await saveAllIfEnabled(page);
  const saved = await readSavedGraph(page);
  const savedKnot = saved.nodes.find((node) => node.data.__reroute === true);
  expect(savedKnot?.data.__nodeType ?? savedKnot?.type).toBe("flow.reroute");

  // (b) The knot drags like any node.
  const knot = knots.first();
  const before = await knot.boundingBox();
  const start = await center(knot.locator(".graph-reroute-knot"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 120, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await knot.boundingBox())!.y - before!.y).toBeGreaterThan(80);
  await expect(edges).toHaveCount(3);

  // (c) Cut Links: a wire, then every wire on a pin, then the knot.
  const root = page.locator('[data-testid="graph-editor"][data-graph-tool="cut"]');
  await editor.getByTestId("graph-cut-links").click();
  await expect(root).toHaveCount(1);
  point = await wireMiddle(editor, "y");
  await page.mouse.move(point.x, point.y);
  await shot(page, editor, "class-cut-tool", testInfo);
  await page.mouse.click(point.x, point.y);
  await expect(editor.locator('.react-flow__edge[data-id="y"]')).toHaveCount(0);
  await expect(edges).toHaveCount(2);

  // Wire Tick into the knot's input as well, so its In has two wires, then cut the pin.
  await editor.getByTestId("graph-cut-links").click();
  await expect(root).toHaveCount(0);
  const tickOut = await center(editor.locator('[data-id="tick"] [data-handleid="execOut"]'));
  const knotIn = await center(editor.locator(`[data-id="${knotId}"] [data-handleid="in"]`));
  await page.mouse.move(tickOut.x, tickOut.y);
  await page.mouse.down();
  await page.mouse.move(knotIn.x, knotIn.y, { steps: 12 });
  await page.mouse.up();
  await expect(edges).toHaveCount(3);
  await editor.getByTestId("graph-cut-links").click();
  await expect(root).toHaveCount(1);
  await page.mouse.click(knotIn.x, knotIn.y);
  await expect(edges).toHaveCount(1);

  const knotBody = await center(knot.locator(".graph-reroute-knot"));
  await page.mouse.click(knotBody.x, knotBody.y);
  await expect(knots).toHaveCount(0);
  await expect(edges).toHaveCount(0);
  // The tool stays on until it is turned off (the Engine Setting's default).
  await expect(root).toHaveCount(1);
  await editor.getByTestId("graph-cut-links").click();
  await expect(root).toHaveCount(0);
});

test("a Custom Event created from Add Node is named in its node header, and its title renames it again", async ({ page }) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  const graph: SerializedGraph = {
    nodes: [{ id: "begin", type: "flow.event.beginPlay", position: { x: 80, y: 80 }, data: {} }],
    edges: [],
  };
  const installed = await page.evaluate(async (next) => (
    globalThis as unknown as { __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } }
  ).__hapticTest.setMainGraphContent(next), graph);
  expect(installed).toBe(true);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const editor = page.getByTestId("graph-editor");
  await expect(editor.locator('.react-flow__node[data-id="begin"]')).toBeVisible({ timeout: 15_000 });

  await editor.getByTestId("graph-add-node").click();
  // The list is windowed: search brings the row into view.
  await page.getByTestId("node-palette-search").fill("Create New Custom Event");
  await page.getByTestId("node-palette-item-flow.event.custom").click();
  const field = editor.getByTestId("graph-node-rename");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("NewEvent");
  await page.keyboard.type("Open Door");
  await page.keyboard.press("Enter");
  await expect(field).toHaveCount(0);
  const title = editor.getByText("Event Open Door", { exact: true });
  await expect(title).toBeVisible();

  await title.dblclick();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Open Door");
  await page.keyboard.type("Close Door");
  await page.keyboard.press("Enter");
  await expect(editor.getByText("Event Close Door", { exact: true })).toBeVisible();
  await title.waitFor({ state: "detached" });
});

test("on touch, a double-tap on a wire adds a knot and a double-tap on a Custom Event's title renames it", {
  tag: IPAD_TEST_TAG,
}, async ({ page, hasTouch }) => {
  test.skip(!hasTouch, "Taps need a touch screen.");
  test.setTimeout(120_000);
  await openTestProject(page);
  const graph: SerializedGraph = {
    nodes: [
      { id: "begin", type: "flow.event.beginPlay", position: { x: 80, y: 80 }, data: {} },
      { id: "print", type: "debug.print", position: { x: 760, y: 80 }, data: {} },
      { id: "hit", type: "flow.event.custom", position: { x: 80, y: 360 }, data: { name: "Hit", title: "Event Hit", pins: [] } },
    ],
    edges: [{ id: "x", source: "begin", sourceHandle: "execOut", target: "print", targetHandle: "execIn" }],
  };
  const installed = await page.evaluate(async (next) => (
    globalThis as unknown as { __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } }
  ).__hapticTest.setMainGraphContent(next), graph);
  expect(installed).toBe(true);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const editor = page.getByTestId("graph-editor");
  await expect(editor.locator('.react-flow__node[data-id="print"]')).toBeVisible({ timeout: 15_000 });

  const point = await wireMiddle(editor, "x");
  await page.touchscreen.tap(point.x, point.y);
  await page.touchscreen.tap(point.x, point.y);
  await expect(editor.locator('.react-flow__node:has([data-node-kind="reroute"])')).toHaveCount(1);
  await expect(editor.locator(".react-flow__edge")).toHaveCount(2);

  const title = await center(editor.getByText("Event Hit", { exact: true }));
  await page.touchscreen.tap(title.x, title.y);
  await page.touchscreen.tap(title.x, title.y);
  await expect(editor.getByTestId("graph-node-rename")).toHaveValue("Hit");
});
