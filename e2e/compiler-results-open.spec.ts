import { IPAD_TEST_TAG, WEBKIT_SMOKE_TAG } from "./ipad-tag";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { waitForPlayOverlay } from "./play";
import { expect, test } from "./profile-context";
import { saveAllIfEnabled } from "./save-all";

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

/** Event Tick into an Assert Equal with neither value wired: warnings, which never block Play. */
const UNWIRED_ASSERT = {
  nodes: [
    { id: "tick", type: "flow.event.tick", position: { x: 40, y: 80 }, data: {} },
    { id: "check", type: "debug.assertEqual", position: { x: 320, y: 80 }, data: {} },
  ],
  edges: [
    { id: "e1", source: "tick", target: "check", sourceHandle: "execOut", targetHandle: "execIn" },
  ],
};

async function setMannequinGraph(page: import("@playwright/test").Page, graph: unknown): Promise<void> {
  await page.evaluate(async (content) => {
    const host = globalThis as unknown as {
      __hapticTest?: { setMainGraphContent: (g: unknown) => Promise<boolean> };
    };
    await host.__hapticTest?.setMainGraphContent(content);
  }, graph);
}

test.describe("Compiler Results", () => {
  test("Open brings a covered Event Graph forward and selects the result's node", {
    tag: [IPAD_TEST_TAG, WEBKIT_SMOKE_TAG],
  }, async ({ page, hasTouch }) => {
    await openTestProject(page);
    await setMannequinGraph(page, MISMATCHED_BRANCH);
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

  test("Open on a result Play reported for a Class opens that Class, and the Scene keeps its results", async ({ page }) => {
    await openTestProject(page);
    await setMannequinGraph(page, UNWIRED_ASSERT);
    await saveAllIfEnabled(page);
    await openMainScene(page);
    await page.getByTestId("play-preview").click();
    await waitForPlayOverlay(page);
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);

    // Play listed the Mannequin Class's warnings in the Scene's results, under the Class's name.
    const scene = page.getByTestId("document-workspace-scene");
    await scene.locator(".dv-tab", { hasText: "Compiler Results" }).click();
    const results = scene.getByTestId("compiler-results");
    await expect(results.getByText("Mannequin Class", { exact: true })).toBeVisible({ timeout: 15_000 });
    const row = results.getByTestId("compiler-result-row").first();
    await row.dblclick();

    const classTab = page.locator('[data-testid="document-tab"][data-document-kind="graph"]');
    await expect(classTab).toHaveAttribute("data-active", "true");
    await expect(
      page.getByTestId("document-workspace-graph").locator('.react-flow__node.selected[data-id="check"]'),
    ).toBeVisible();

    // Back in the Scene, the results Play reported are still there.
    await openMainScene(page);
    await scene.locator(".dv-tab", { hasText: "Compiler Results" }).click();
    await expect(results.getByText("Mannequin Class", { exact: true })).toBeVisible();
    await expect(results.getByTestId("compiler-result-row").first()).toBeVisible();
  });
});
