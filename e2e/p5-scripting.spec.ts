import { expect, test } from "@playwright/test";
import { openTestProject } from "./open-test-project";

/**
 * Event Tick → Print("P5 script running"), keyed so repeated ticks replace the
 * on-screen entry instead of appending.
 */
const SCRIPTED_GRAPH = {
  nodes: [
    {
      id: "tick",
      type: "flow.event.tick",
      position: { x: 40, y: 80 },
      data: {},
    },
    {
      id: "print",
      type: "debug.print",
      position: { x: 320, y: 80 },
      data: {
        value: "P5 script running",
        key: "p5",
        duration: 30,
        color: { x: 0.4, y: 1, z: 0.6, w: 1 },
      },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "tick",
      target: "print",
      sourceHandle: "execOut",
      targetHandle: "execIn",
    },
  ],
};

test.describe("P5 visual scripting acceptance", () => {
  test("a scripted actor compiles and runs in Preview", async ({ page }) => {
    await openTestProject(page);

    const installed = await page.evaluate(async (graph) => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setMainGraphContent: (g: unknown) => Promise<boolean>;
        };
      };
      if (!host.__babylonslateTest) return false;
      return host.__babylonslateTest.setMainGraphContent(graph);
    }, SCRIPTED_GRAPH);
    expect(installed).toBe(true);

    await page.locator('[data-asset-path="assets/main.graph.babasset"]').dblclick();
    await expect(page.getByTestId("compile-graph")).toBeVisible();
    await expect(page.getByTestId("compilation-error")).toHaveCount(0);

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();

    // The Print node only reaches the overlay if the graph compiled, loaded as
    // a module, and its Event Tick entry point ran against a live actor.
    await expect(page.getByTestId("print-overlay")).toContainText(
      "P5 script running",
      { timeout: 15_000 },
    );

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });

  test("a type mismatch blocks Preview and tap-to-navigate focuses the node", async ({
    page,
  }) => {
    await openTestProject(page);

    await page.evaluate(async () => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setMainGraphContent: (g: unknown) => Promise<boolean>;
        };
      };
      await host.__babylonslateTest?.setMainGraphContent({
        nodes: [
          {
            id: "tick",
            type: "flow.event.tick",
            position: { x: 40, y: 80 },
            data: {},
          },
          {
            id: "branch",
            type: "flow.branch",
            position: { x: 320, y: 80 },
            data: {},
          },
        ],
        edges: [
          {
            id: "e1",
            source: "tick",
            target: "branch",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
          {
            id: "e2",
            source: "tick",
            target: "branch",
            sourceHandle: "deltaSeconds",
            targetHandle: "condition",
          },
        ],
      });
    });

    await page.locator('[data-asset-path="assets/main.graph.babasset"]').dblclick();
    await expect(page.getByTestId("compiler-results")).toBeVisible();
    await expect(page.getByTestId("compiler-result-row").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("play-error-badge")).toBeVisible();
    await expect(page.getByTestId("compilation-error")).toBeVisible();
    await expect(page.getByTestId("compilation-error")).toHaveText(
      "Compilation Error",
    );

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-blocked-dialog")).toBeVisible();
    await page.getByTestId("play-blocked-row").first().click();
    await expect(
      page.locator('.react-flow__node.selected[data-id="branch"]'),
    ).toBeVisible({ timeout: 10_000 });
  });
});
