import { expect, test } from "@playwright/test";
import {
  openAssetFromBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";

async function injectGamepad(
  page: { evaluate: (fn: (next: unknown) => void, arg: unknown) => Promise<unknown> },
  pad: { axes: number[]; buttons?: number[] } | null,
): Promise<void> {
  await page.evaluate((next) => {
    (
      globalThis as {
        __babylonslateTest: {
          injectTestGamepad: (
            pad: {
              index?: number;
              axes?: number[];
              buttons?: number[];
            } | null,
          ) => void;
        };
      }
    ).__babylonslateTest.injectTestGamepad(
      next
        ? {
            index: 0,
            axes: (next as { axes: number[] }).axes,
            buttons: (next as { buttons?: number[] }).buttons ?? [0, 0, 0, 0],
          }
        : null,
    );
  }, pad);
}

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


async function classGraphNodeCount(page: import("@playwright/test").Page) {
  return page.getByTestId("graph-panel").locator(".react-flow__node").count();
}

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

    await openMainScene(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("compile-graph")).toBeVisible();
    await expect(page.getByTestId("compilation-error")).toHaveCount(0);

    await clickPlayAndWaitForOverlay(page);

    // The Print node only reaches the overlay if the graph compiled, loaded as
    // a module, and its Event Tick entry point ran against a live actor.
    await expect(page.getByTestId("print-overlay")).toContainText(
      "P5 script running",
      { timeout: 15_000 },
    );

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });

  test("Play without a scene tab is disabled", async ({ page }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeDisabled();
  });

  test("GetAxis2D Move from a compiled graph prints the stick in Play", async ({
    page,
  }) => {
    await openTestProject(page);

    const installed = await page.evaluate(async (graph) => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setMainGraphContent: (g: unknown) => Promise<boolean>;
        };
      };
      if (!host.__babylonslateTest) return false;
      return host.__babylonslateTest.setMainGraphContent(graph);
    }, {
      nodes: [
        {
          id: "tick",
          type: "flow.event.tick",
          position: { x: 40, y: 80 },
          data: {},
        },
        {
          id: "axis",
          type: "input.getAxis2D",
          position: { x: 40, y: 200 },
          data: { axis: "Move" },
        },
        {
          id: "print",
          type: "debug.print",
          position: { x: 320, y: 80 },
          data: {
            key: "axis",
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
        {
          id: "e2",
          source: "axis",
          target: "print",
          sourceHandle: "out",
          targetHandle: "value",
        },
      ],
    });
    expect(installed).toBe(true);

    await injectGamepad(page, { axes: [0.85, 0, 0, 0] });
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("print-overlay")).toContainText("0.8", {
      timeout: 15_000,
    });
    await page.getByTestId("play-overlay-close").click();
    await injectGamepad(page, null);
  });

  test("Format String and dynamic Enum Select compile and run in Preview", async ({
    page,
  }) => {
    await openTestProject(page);

    const installed = await page.evaluate(async () => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setMainGraphContent: (g: unknown) => Promise<boolean>;
        };
      };
      return host.__babylonslateTest?.setMainGraphContent({
        nodes: [
          {
            id: "tick",
            type: "flow.event.tick",
            position: { x: 40, y: 80 },
            data: {},
          },
          {
            id: "value",
            type: "literal.makeInt",
            position: { x: 40, y: 240 },
            data: { "default:in": 42 },
          },
          {
            id: "select",
            type: "enum.select",
            position: { x: 280, y: 220 },
            data: {
              enumGuid: "engine:InputMode",
              members: [
                { name: "All", value: 0 },
                { name: "Interface", value: 1 },
                { name: "Game", value: 2 },
              ],
              "default:index": "Interface",
            },
          },
          {
            id: "format",
            type: "string.format",
            position: { x: 520, y: 180 },
            data: { "default:format": "Selected {input pin}" },
          },
          {
            id: "print",
            type: "debug.print",
            position: { x: 780, y: 80 },
            data: {
              key: "format-select",
              duration: 30,
              color: { x: 0.4, y: 1, z: 0.6, w: 1 },
            },
          },
        ],
        edges: [
          {
            id: "exec",
            source: "tick",
            target: "print",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
          {
            id: "option",
            source: "value",
            target: "select",
            sourceHandle: "out",
            targetHandle: "option:Interface",
          },
          {
            id: "selected",
            source: "select",
            target: "format",
            sourceHandle: "out",
            targetHandle: `arg:${encodeURIComponent("input pin")}`,
          },
          {
            id: "formatted",
            source: "format",
            target: "print",
            sourceHandle: "out",
            targetHandle: "value",
          },
        ],
      }) ?? false;
    });
    expect(installed).toBe(true);

    await openAssetFromBrowser(page, "assets/main.class.babasset");
    const formattedArg = page.locator(
      '[data-id="format"] [data-handleid="arg:input%20pin"]',
    );
    await expect(formattedArg).toBeVisible();
    await saveAllIfEnabled(page);
    await page
      .locator('[data-testid="document-tab"][data-document-kind="graph"]')
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("graph-panel")).toHaveCount(0);
    await openAssetFromBrowser(page, "assets/main.class.babasset");
    await expect(formattedArg).toBeVisible();

    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("print-overlay")).toContainText(
      "Selected 42",
      { timeout: 15_000 },
    );
    await page.getByTestId("play-overlay-close").click();
  });

  test("For Loop executes its body and exposes the final Index in Preview", async ({
    page,
  }) => {
    await openTestProject(page);
    const installed = await page.evaluate(async () => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          setMainGraphContent: (g: unknown) => Promise<boolean>;
        };
      };
      return host.__babylonslateTest?.setMainGraphContent({
        nodes: [
          {
            id: "tick",
            type: "flow.event.tick",
            position: { x: 40, y: 80 },
            data: {},
          },
          {
            id: "loop",
            type: "flow.forLoop",
            position: { x: 300, y: 80 },
            data: {
              "default:firstIndex": 0,
              "default:lastIndex": 2,
            },
          },
          {
            id: "print",
            type: "debug.print",
            position: { x: 580, y: 80 },
            data: {
              key: "for-loop",
              duration: 30,
              color: { x: 0.4, y: 1, z: 0.6, w: 1 },
            },
          },
        ],
        edges: [
          {
            id: "start",
            source: "tick",
            target: "loop",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
          {
            id: "body",
            source: "loop",
            target: "print",
            sourceHandle: "loopBody",
            targetHandle: "execIn",
          },
          {
            id: "index",
            source: "loop",
            target: "print",
            sourceHandle: "index",
            targetHandle: "value",
          },
        ],
      }) ?? false;
    });
    expect(installed).toBe(true);

    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("print-overlay")).toContainText("2", {
      timeout: 15_000,
    });
    await page.getByTestId("play-overlay-close").click();
  });

  test("the node palette can add Get Axis 2D on the Class graph", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    const graph = page.getByTestId("graph-panel");
    await expect(graph).toBeVisible();
    const nodes = graph.locator(".react-flow__node");
    const baseline = await classGraphNodeCount(page);
    expect(baseline).toBeGreaterThan(0);

    await graph.locator(".react-flow__pane").dblclick({ position: { x: 24, y: 24 } });
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Get Axis 2D");
    await page.getByTestId("node-palette-item-input.getAxis2D").click();
    await expect(nodes).toHaveCount(baseline + 1);
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

    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("compiler-results")).toBeVisible();
    await expect(page.getByTestId("compiler-result-row").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("play-error-badge")).toBeVisible();
    await expect(page.getByTestId("compilation-error")).toBeVisible();
    await expect(page.getByTestId("compilation-error")).toHaveText(
      "Compilation Error",
    );

    await openMainScene(page);
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-blocked-dialog")).toBeVisible();
    await page.getByTestId("play-blocked-row").first().click();
    await expect(
      page.locator('.react-flow__node.selected[data-id="branch"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("chrome undo and redo restore a node added on the Class graph", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    const graph = page.getByTestId("graph-panel");
    await expect(graph).toBeVisible();
    const nodes = graph.locator(".react-flow__node");
    const baseline = await classGraphNodeCount(page);
    expect(baseline).toBeGreaterThan(0);

    const pane = graph.locator(".react-flow__pane");
    await pane.dblclick({ position: { x: 24, y: 24 } });
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Log");
    await page.getByTestId("node-palette-item-debug.log").click();
    await expect(nodes).toHaveCount(baseline + 1);

    await expect(page.getByTestId("undo-document")).toBeEnabled();
    await page.getByTestId("undo-document").click();
    await expect(nodes).toHaveCount(baseline);

    await expect(page.getByTestId("redo-document")).toBeEnabled();
    await page.getByTestId("redo-document").click();
    await expect(nodes).toHaveCount(baseline + 1);
  });

  test("Add Node search finds Cast to Actor", async ({ page }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    const graph = page.getByTestId("graph-panel");
    await expect(graph).toBeVisible();
    const nodes = graph.locator(".react-flow__node");
    const baseline = await classGraphNodeCount(page);
    expect(baseline).toBeGreaterThan(0);

    await graph.locator(".react-flow__pane").dblclick({ position: { x: 24, y: 24 } });
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Cast to Actor");
    await expect(page.getByTestId("node-palette-item-casting.castActor")).toHaveCount(
      0,
    );
    await page.getByTestId("node-palette-item-casting.cast:Actor").click();
    await expect(nodes).toHaveCount(baseline + 1);
    await expect(graph.getByText("Cast to Actor")).toBeVisible();
  });
});
