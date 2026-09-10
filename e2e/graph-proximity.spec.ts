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
        id: "spawn",
        type: "actor.spawn",
        position: { x: 80, y: 80 },
        data: {},
      },
      {
        id: "destroy",
        type: "actor.destroy",
        position: { x: 2000, y: 80 },
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
    .locator('.react-flow__node[data-id="destroy"]')
    .getByText("Destroy Actor", { exact: true });
  const source = await center(
    editor.locator('[data-id="spawn"] [data-handleid="execOut"]'),
  );
  const target = await center(
    editor.locator('[data-id="destroy"] [data-handleid="execIn"]'),
  );
  const start = await center(title);
  const near = {
    x: start.x + source.x + 24 - target.x,
    y: start.y + source.y - target.y,
  };
  await expect(preview).toHaveCount(0);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A sustained drag lets the document host echo intermediate position frames
  // before the node enters connection range, as it does during a long move.
  for (let step = 1; step <= 30; step++) {
    await page.mouse.move(
      start.x + (near.x - start.x) * step / 30,
      start.y + (near.y - start.y) * step / 30,
    );
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
  }
  await expect(preview).toHaveCount(2);
  await expect(preview.first()).toHaveCSS("opacity", "0.5");
  await expect(preview.first()).toHaveCSS("pointer-events", "none");
  await expect(edges).toHaveCount(0);

  // A suggestion is cancelled when the node is moved away before releasing it.
  await page.mouse.move(start.x, start.y, { steps: 10 });
  await expect(preview).toHaveCount(0);
  // Re-enter connection range without releasing and picking the node up again.
  await page.mouse.move(near.x, near.y, { steps: 30 });
  await expect(preview).toHaveCount(2);
  await page.mouse.move(start.x, start.y, { steps: 30 });
  await expect(preview).toHaveCount(0);
  await page.mouse.up();
  await expect(edges).toHaveCount(0);
  await saveAllIfEnabled(page);
  expect((await readSavedGraph(page)).edges).toEqual([]);

  const secondStart = await center(title);
  const secondSource = await center(
    editor.locator('[data-id="spawn"] [data-handleid="execOut"]'),
  );
  const secondTarget = await center(
    editor.locator('[data-id="destroy"] [data-handleid="execIn"]'),
  );
  await page.mouse.move(secondStart.x, secondStart.y);
  await page.mouse.down();
  await page.mouse.move(
    secondStart.x + secondSource.x + 24 - secondTarget.x,
    secondStart.y + secondSource.y - secondTarget.y,
    { steps: 30 },
  );
  await expect(preview).toHaveCount(2);
  await expect(edges).toHaveCount(0);
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(edges).toHaveCount(2);
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await saveAllIfEnabled(page);
  expect((await readSavedGraph(page)).edges).toEqual([
    expect.objectContaining({
      source: "spawn",
      sourceHandle: "execOut",
      target: "destroy",
      targetHandle: "execIn",
    }),
    expect.objectContaining({
      source: "spawn",
      sourceHandle: "out",
      target: "destroy",
      targetHandle: "target",
    }),
  ]);
});


test("Class JavaScript shares the colored editor and read-only node preview", async ({ page }, testInfo) => {
  await openTestProject(page);
  await page.evaluate(async () => {
    const host = globalThis as unknown as { __babylonslateTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> } };
    await host.__babylonslateTest.setMainGraphContent({ nodes: [{ id: "custom-js", type: "debug.executeJavaScript", position: { x: 0, y: 0 }, data: { body: "const amount = 1;\nreturn amount;" } }], edges: [] });
  });
  await openAssetFromBrowser(page, GRAPH_PATH);
  const node = page.getByTestId("graph-editor").locator('[data-id="custom-js"]');
  await expect(node.getByTestId("js-code-preview")).toContainText("const amount");
  await node.click();
  await page.getByTestId("class-node-code").click();
  const editor = page.getByRole("textbox", { name: "JavaScript Function Body" });
  await editor.fill("const amount = 2;\nret");
  await editor.press("End");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: "return", exact: true })).toBeVisible();
  await editor.press("Escape");
  await editor.fill("const amount = 2;\nreturn amount;");
  await page.screenshot({ path: testInfo.outputPath("class-code-editor.png") });
  await page.getByTestId("class-node-code-done").click();
  await expect(node.getByTestId("js-code-preview")).toContainText("const amount = 2");
});
