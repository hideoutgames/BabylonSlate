import { IPAD_TEST_TAG, WEBKIT_SMOKE_TAG } from "./ipad-tag";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";
import { expect, test } from "./profile-context";

/** Event Tick's Delta Seconds (float) wired into Branch's Condition (bool): a type mismatch on `branch`. */
const MISMATCHED_BRANCH = {
  nodes: [
    { id: "tick", type: "flow.event.tick", position: { x: 40, y: 80 }, data: {} },
    { id: "branch", type: "flow.branch", position: { x: 320, y: 80 }, data: {} },
  ],
  edges: [
    { id: "e1", source: "tick", target: "branch", sourceHandle: "execOut", targetHandle: "execIn" },
    { id: "e2", source: "tick", target: "branch", sourceHandle: "deltaSeconds", targetHandle: "condition" },
  ],
};

test.describe("Compiler Results", () => {
  test("Open brings a covered Event Graph forward and selects the result's node", {
    tag: [IPAD_TEST_TAG, WEBKIT_SMOKE_TAG],
  }, async ({ page, hasTouch }) => {
    await openTestProject(page);
    await page.evaluate(async (graph) => {
      const host = globalThis as unknown as {
        __hapticTest?: { setMainGraphContent: (g: unknown) => Promise<boolean> };
      };
      await host.__hapticTest?.setMainGraphContent(graph);
    }, MISMATCHED_BRANCH);
    await openAssetFromBrowser(page, "assets/Mannequin.class.hasset");

    const row = page.getByTestId("compiler-result-row").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const graph = page.getByTestId("graph-panel").first();
    const branch = graph.locator('.react-flow__node.selected[data-id="branch"]');
    const coverGraph = async () => {
      await page.locator(".dv-tab", { hasText: "Prefab" }).first().click();
      await expect(graph).toBeHidden();
    };

    // The row menu's Open.
    await coverGraph();
    await row.click({ button: "right" });
    await page.getByTestId("diagnostic-menu-open").click();
    await expect(graph).toBeVisible();
    await expect(branch).toBeVisible();

    // Selecting nothing ends the focus; a double-tap or double-click opens the row again.
    await graph.locator(".react-flow__pane").click({ position: { x: 24, y: 24 } });
    await expect(branch).toHaveCount(0);
    await coverGraph();
    if (hasTouch) {
      await row.tap();
      await row.tap();
    } else {
      await row.dblclick();
    }
    await expect(graph).toBeVisible();
    await expect(branch).toBeVisible();
  });
});
