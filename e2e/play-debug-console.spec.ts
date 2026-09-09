import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

for (const mode of ["Play", "Preview Build"] as const) {
  test(`${mode} console overlays the view, captures warnings and runs debug commands`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);
    if (mode === "Preview Build") {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
      await page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-root").evaluate(() => console.warn("Console integration warning"));
      await page.getByRole("button", { name: "Console", exact: true }).click();
    } else {
      await clickPlayAndWaitForOverlay(page);
      await page.evaluate(() => console.warn("Console integration warning"));
      await page.getByTestId("play-console-open").click();
    }
    const consolePanel = page.getByTestId("debug-console");
    const input = page.getByTestId("debug-console-input");
    const transcript = page.getByTestId("debug-console-transcript");
    await expect(consolePanel).toBeVisible();
    await expect(transcript).toContainText("[warning] Console integration warning");
    await input.fill("nav");
    await expect(page.getByRole("option", { name: /shownavagent/ })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Console Suggestions" })).toBeVisible();
    const rect = await consolePanel.boundingBox();
    const viewport = page.viewportSize()!;
    expect(rect!.width).toBeGreaterThan(viewport.width * 0.95);
    expect(rect!.height).toBeLessThan(viewport.height * 0.7);
    expect(Math.abs(rect!.y + rect!.height - viewport.height)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("console.png") });
    for (const line of ["debugphysics on", "showpathfinding on", "shownavagent on", "shownavdebug on", "wireframe on", "wireframe off", "pause", "resume"]) {
      await input.fill(line);
      await page.getByTestId("debug-console-submit").click();
      await expect(page.getByTestId("debug-console-submit")).toBeEnabled();
      await expect(transcript).toContainText(line === "pause" ? "paused" : line === "resume" ? "resumed" : line);
      await expect(transcript).not.toContainText("Unknown command");
    }
    await input.fill("behaviourtreedebug on");
    await page.getByTestId("debug-console-submit").click();
    await expect(page.getByTestId("behaviour-tree-debugger")).toBeVisible();
    await expect(page.getByText("No Running Behaviour Trees")).toBeVisible();
    await page.getByTestId("behaviour-tree-debugger").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTestId(mode === "Play" ? "play-overlay-close" : "preview-build-close").click();
    await expect(page.getByTestId(mode === "Play" ? "play-overlay" : "preview-build-overlay")).toHaveCount(0);
  });
}
