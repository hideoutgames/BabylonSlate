import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { enableTapToConnect, openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

const GRAPH_PATH = "assets/Mannequin.class.hasset";

type TestHost = { __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } };

const node = (id: string, type: string, x: number, y: number, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x, y }, data });
const wire = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id, source, sourceHandle, target, targetHandle });

/** Event Tick prints `value` on a fixed key, so the overlay shows the latest value. */
function printOnTick(value: { source: string; pin: string } | null): { nodes: SerializedGraph["nodes"]; edges: SerializedGraph["edges"] } {
  return {
    nodes: [
      node("tick", "flow.event.tick", 0, 0),
      node("print", "debug.print", 1400, 0, { "default:key": "mx", "default:duration": 30 }),
    ],
    edges: [
      wire("exec", "tick", "execOut", "print", "execIn"),
      ...(value ? [wire("value", value.source, value.pin, "print", "value")] : []),
    ],
  };
}

async function installAndOpen(page: Page, graph: SerializedGraph): Promise<Locator> {
  expect(await page.evaluate((next) => (globalThis as unknown as TestHost).__hapticTest.setMainGraphContent(next), graph)).toBe(true);
  await openMainScene(page);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const editor = page.getByTestId("graph-panel");
  await expect(editor.locator('.react-flow__node[data-id="print"]')).toBeVisible({ timeout: 15_000 });
  return editor;
}

/** Plays, reads the printed value, and closes Play. */
async function playAndRead(page: Page, expected: string): Promise<void> {
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText(expected, { timeout: 15_000 });
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
}

async function typeFormula(page: Page, editor: Locator, nodeId: string, formula: string): Promise<void> {
  await editor.locator(`[data-testid="math-expression-${nodeId}"] [data-testid="math-expression-formula"]`).dblclick();
  const field = editor.getByTestId("math-expression-formula-input");
  await expect(field).toBeFocused();
  await field.fill(formula);
  await field.press("Control+Enter");
  await expect(field).toHaveCount(0);
}

async function connect(editor: Locator, source: string, sourcePin: string, target: string, targetPin: string): Promise<void> {
  await editor.locator(`.react-flow__node[data-id="${source}"] [data-handleid="${sourcePin}"][data-handlepos="right"]`).click({ force: true });
  await editor.locator(`.react-flow__node[data-id="${target}"] [data-handleid="${targetPin}"][data-handlepos="left"]`).click({ force: true });
}

test.describe("Math Expression", () => {
  test.beforeEach(async ({ page }) => {
    await enableTapToConnect(page);
  });

  test("a typed formula makes its pins, computes in Play, and keeps its wire through a rename", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    const print = printOnTick(null);
    const editor = await installAndOpen(page, {
      nodes: [...print.nodes, node("src", "literal.makeFloat", 0, 300, { "default:in": 3 }), node("mx", "math.expression", 600, 300)],
      edges: print.edges,
    });
    const mx = editor.locator('.react-flow__node[data-id="mx"]');
    // A new node has no pins.
    await expect(mx.locator("[data-handleid]")).toHaveCount(0);

    await typeFormula(page, editor, "mx", "y = a * 2 + 1");
    await expect(mx.locator('[data-handleid="in_a"]')).toHaveCount(1);
    await expect(mx.locator('[data-handleid="out_y"]')).toHaveCount(1);
    await connect(editor, "src", "out", "mx", "in_a");
    await connect(editor, "mx", "out_y", "print", "value");
    await expect(editor.locator(".react-flow__edge")).toHaveCount(3);
    await playAndRead(page, "7");

    // Renaming the input keeps its wire: unwired, it would read 0 and print 1.
    await typeFormula(page, editor, "mx", "y = speed * 2 + 1");
    await expect(mx.locator('[data-handleid="in_speed"]')).toHaveCount(1);
    await expect(mx.locator('[data-handleid="in_a"]')).toHaveCount(0);
    await expect(editor.locator(".react-flow__edge")).toHaveCount(3);
    await playAndRead(page, "7");
  });

  test("the Inspector's Formula opens in a Text Editor tab that edits the node", async ({ page }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    const print = printOnTick(null);
    const editor = await installAndOpen(page, {
      nodes: [...print.nodes, node("mx", "math.expression", 600, 300, { formula: "y = a * 2" })],
      edges: print.edges,
    });
    const mx = editor.locator('.react-flow__node[data-id="mx"]');
    await mx.click();
    const field = page.getByTestId("math-expression-formula-field-editor");
    await expect(field).toHaveValue("y = a * 2");

    await page.getByTestId("math-expression-formula-field-open-tab").click();
    const textTab = page.locator('[data-testid="document-tab"][data-document-kind="text-editor"]');
    await expect(textTab).toHaveAttribute("data-active", "true");
    await expect(textTab).toContainText("Formula: ");
    const tabEditor = page.getByTestId("document-workspace-text-editor").getByTestId("text-editor-workspace-editor");
    await expect(tabEditor).toBeFocused();
    await expect(tabEditor).toHaveValue("y = a * 2");
    await tabEditor.fill("y = speed * 3");

    // Leaving the tab commits; the source tab's Inspector and node show the new formula.
    await page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByRole("button", { name: /Mannequin/ }).first().click();
    await expect(field).toHaveValue("y = speed * 3");
    await expect(mx.getByTestId("math-expression-formula")).toHaveText("y = speed * 3");
    await expect(mx.locator('[data-handleid="in_speed"]')).toHaveCount(1);

    await textTab.getByTestId("document-tab-close").click();
    await expect(textTab).toHaveCount(0);
    await expect(field).toHaveValue("y = speed * 3");
    await expect(mx.getByTestId("math-expression-formula")).toHaveText("y = speed * 3");
  });

  test("three math nodes convert to one Math Expression and back with the same result", async ({ page }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    const print = printOnTick({ source: "neg", pin: "out" });
    const editor = await installAndOpen(page, {
      nodes: [
        ...print.nodes,
        node("src", "literal.makeFloat", 0, 300, { "default:in": 3 }),
        node("mul", "math.mul", 400, 300, { "default:b": 2 }),
        node("add", "math.add", 800, 300, { "default:b": 1 }),
        node("neg", "math.negate", 1100, 300),
      ],
      edges: [
        ...print.edges,
        wire("w1", "src", "out", "mul", "a"),
        wire("w2", "mul", "out", "add", "a"),
        wire("w3", "add", "out", "neg", "in"),
      ],
    });
    await playAndRead(page, "-7");

    const title = (id: string) => editor.locator(`.react-flow__node[data-id="${id}"] [data-node-title]`);
    await title("mul").click();
    await title("add").click({ modifiers: ["Control"] });
    await title("neg").click({ modifiers: ["Control"] });
    await title("neg").click({ button: "right" });
    await page.getByTestId("graph-convert-math-expression").click();
    const expression = editor.locator('[data-node-kind="math-expression"]');
    await expect(expression).toHaveCount(1);
    await expect(editor.locator('.react-flow__node[data-id="mul"]')).toHaveCount(0);
    await expect(expression.getByTestId("math-expression-formula")).toHaveText("negate = -(makeFloat * 2 + 1)");
    await playAndRead(page, "-7");

    await expression.getByTestId("math-expression-formula").click({ button: "right" });
    await page.getByTestId("graph-convert-math-nodes").click();
    await expect(editor.locator('[data-node-kind="math-expression"]')).toHaveCount(0);
    await expect(editor.locator(".react-flow__node")).toHaveCount(6);
    await playAndRead(page, "-7");
  });
});
