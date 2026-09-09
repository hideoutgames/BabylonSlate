import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

const GRAPH_PATH = "assets/Mannequin.class.babasset";

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function readSavedGraph(page: Page): Promise<SerializedGraph> {
  return page.evaluate(async (path) => {
    const bytes = await (
      globalThis as unknown as {
        __babylonslateTest: {
          readAssetChunk: (path: string, chunk: string) => Promise<Uint8Array>;
        };
      }
    ).__babylonslateTest.readAssetChunk(path, "document");
    return JSON.parse(new TextDecoder().decode(bytes)) as SerializedGraph;
  }, GRAPH_PATH);
}

test("nearby unused graph pins preview during a node drag and connect only on drop", async ({
  page,
}) => {
  await openTestProject(page);
  const graph: SerializedGraph = {
    nodes: [
      {
        id: "begin",
        type: "flow.event.beginPlay",
        position: { x: 80, y: 80 },
        data: {},
      },
      {
        id: "print",
        type: "debug.print",
        position: { x: 900, y: 80 },
        data: {},
      },
    ],
    edges: [],
  };
  const installed = await page.evaluate(async (next) => {
    return (
      globalThis as unknown as {
        __babylonslateTest: {
          setMainGraphContent: (graph: SerializedGraph) => Promise<boolean>;
        };
      }
    ).__babylonslateTest.setMainGraphContent(next);
  }, graph);
  expect(installed).toBe(true);
  await openAssetFromBrowser(page, GRAPH_PATH);
  const editor = page.getByTestId("graph-editor");
  const preview = editor.locator(".graph-proximity-preview");
  const edges = editor.locator(".react-flow__edge");
  const title = editor
    .locator('.react-flow__node[data-id="print"]')
    .getByText("Print", { exact: true });
  const source = await center(
    editor.locator('[data-id="begin"] [data-handleid="execOut"]'),
  );
  const target = await center(
    editor.locator('[data-id="print"] [data-handleid="execIn"]'),
  );
  const start = await center(title);
  const near = {
    x: start.x + source.x + 50 - target.x,
    y: start.y + source.y - target.y,
  };
  await expect(preview).toHaveCount(0);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(near.x, near.y, { steps: 10 });
  await expect(preview).toHaveCount(1);
  await expect(preview).toHaveCSS("opacity", "0.5");
  await expect(preview).toHaveCSS("pointer-events", "none");
  await expect(edges).toHaveCount(0);

  // A suggestion is cancelled when the node is moved away before releasing it.
  await page.mouse.move(start.x, start.y, { steps: 10 });
  await expect(preview).toHaveCount(0);
  await page.mouse.up();
  await expect(edges).toHaveCount(0);
  await saveAllIfEnabled(page);
  expect((await readSavedGraph(page)).edges).toEqual([]);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(near.x, near.y, { steps: 10 });
  await expect(preview).toHaveCount(1);
  await expect(edges).toHaveCount(0);
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(edges).toHaveCount(1);
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await saveAllIfEnabled(page);
  expect((await readSavedGraph(page)).edges).toEqual([
    expect.objectContaining({
      source: "begin",
      sourceHandle: "execOut",
      target: "print",
      targetHandle: "execIn",
    }),
  ]);
});
