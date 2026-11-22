// TEMPORARY review capture; delete after the run.
import { expect, test, type Page } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";

const OUT = "/tmp/claude-0/-workspace-BabylonSlate/c50e83a4-12b6-5e3d-a832-dbe61c8373fd/scratchpad/review";
const GRAPH_PATH = "assets/Mannequin.class.hasset";
type TestHost = { __hapticTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } };
const node = (id: string, type: string, x: number, y: number, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x, y }, data });

test.use({ deviceScaleFactor: 2 });

async function open(page: Page) {
  const body = Array.from({ length: 40 }, (_, index) => `const value${index + 1} = ${index + 1}; // line ${index + 1}`).join("\n");
  const graph: SerializedGraph = {
    nodes: [
      node("tick", "flow.event.tick", 0, 0),
      node("mx", "math.expression", 400, 0, { formula: "y = a * 2 + 1\nz = y / 3" }),
      node("js", "debug.executeJavaScript", 400, 400, { body, inputs: [{ name: "Speed", type: "float" }], outputs: [] }),
    ],
    edges: [],
  };
  expect(await page.evaluate((next) => (globalThis as unknown as TestHost).__hapticTest.setMainGraphContent(next), graph)).toBe(true);
  await openMainScene(page);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const editor = page.getByTestId("graph-panel");
  await expect(editor.locator('.react-flow__node[data-id="js"]')).toBeVisible({ timeout: 15_000 });
  return editor;
}

test("review: inline fields, CodeMirror inline, Text Editor tab", async ({ page }) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  const editor = await open(page);
  const inspector = page.getByTestId("inspector-panel");

  // (a) Math Expression Formula.
  await editor.locator('.react-flow__node[data-id="mx"]').click();
  await expect(page.getByTestId("math-expression-formula-field-open-tab")).toBeVisible();
  await inspector.screenshot({ path: `${OUT}/a-math-expression-inspector.png` });

  // (b) Execute JavaScript: the box height before and after CodeMirror loads.
  await editor.locator('.react-flow__node[data-id="js"]').click();
  const field = page.getByTestId("class-node-code");
  const box = field.locator("> div").last();
  const before = (await box.boundingBox())!.height;
  await expect(field.locator(".cm-editor")).toBeVisible();
  const after = (await box.boundingBox())!.height;
  console.log(`[review] box height before CodeMirror ${before}, after ${after}`);
  expect(after).toBe(before);
  expect(Math.round(after)).toBe(160);
  const scroll = await field.locator(".cm-scroller").evaluate((element) => {
    const { scrollHeight, clientHeight } = element;
    element.scrollTop = scrollHeight;
    return { scrollHeight, clientHeight, scrollTop: element.scrollTop };
  });
  console.log(`[review] scroller ${JSON.stringify(scroll)}`);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.scrollTop).toBeGreaterThan(0);
  await expect(field.getByText("// line 40")).toBeInViewport();
  await field.locator(".cm-scroller").evaluate((element) => { element.scrollTop = 0; });
  await inspector.screenshot({ path: `${OUT}/b-execute-javascript-inspector.png` });

  // Completion inline: shown in full and usable outside the 160px box.
  const content = field.getByRole("textbox", { name: "JavaScript Function Body" });
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Spe");
  await page.keyboard.press("Control+Space");
  const option = page.getByRole("option", { name: "Speed", exact: true });
  await expect(option).toBeVisible();
  const list = page.locator(".cm-tooltip-autocomplete");
  const listBox = (await list.boundingBox())!;
  const viewport = page.viewportSize()!;
  console.log(`[review] completion box ${JSON.stringify(listBox)} field box ${JSON.stringify(await box.boundingBox())}`);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(viewport.height);
  const hit = await option.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return element.contains(top);
  });
  expect(hit).toBe(true);
  await page.screenshot({ path: `${OUT}/b2-inline-completion.png` });
  await option.click();
  await expect(content).toContainText("Speed");
  await expect(content).toBeFocused();

  // (c) Text Editor tab.
  await page.getByTestId("class-node-code-open-tab").click();
  const textTab = page.locator('[data-testid="document-tab"][data-document-kind="text-editor"]');
  await expect(textTab).toHaveAttribute("data-active", "true");
  const tabEditor = page.getByTestId("document-workspace-text-editor").locator(".cm-editor");
  await expect(tabEditor).toBeVisible();
  await expect(tabEditor).toContainText("Speed");
  await page.screenshot({ path: `${OUT}/c-text-editor-tab.png` });
});
