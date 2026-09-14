import { expect, test, type Page } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, openTestProject, waitForSceneViewportReady } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function openRendering(page: Page) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
}

async function choose(page: Page, id: string, name: string) {
  await page.getByTestId(id).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("pipeline preferences preserve the effective viewport and Scene path inheritance through history and reopen", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page);
  await openMainScene(page);
  await openRendering(page);
  await choose(page, "project-render-path", "Clustered Forward");
  await choose(page, "project-gpu-backend", "WebGPU");
  await expect(page.getByTestId("setting-render-mode").locator('[data-slot="select-value"]')).toHaveText("PBR");
  await expect(page.getByTestId("project-render-pipeline-status")).toContainText("Forward · WebGL2");
  await expect(page.getByTestId("project-render-pipeline-status")).toContainText("Your preferences are retained.");
  await page.screenshot({ path: testInfo.outputPath("project-pipeline-preferences.png") });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  await waitForSceneViewportReady(page);
  const rendering = page.getByRole("button", { name: "Rendering", exact: true });
  await expect(rendering).toHaveAttribute("aria-expanded", "false");
  await rendering.click();
  const path = page.getByTestId("scene-render-path");
  await expect(path).toBeDisabled();
  await expect(path.locator('[data-slot="select-value"]')).toHaveText("Clustered Forward");
  await expect(page.getByTestId("project-gpu-backend")).toHaveCount(0);
  await page.getByRole("button", { name: "Override Render Path", exact: true }).click();
  await choose(page, "scene-render-path", "Forward");
  await page.getByTestId("undo-document").click();
  await expect(path.locator('[data-slot="select-value"]')).toHaveText("Clustered Forward");
  await page.getByTestId("redo-document").click();
  await expect(path.locator('[data-slot="select-value"]')).toHaveText("Forward");
  await page.getByRole("button", { name: "Reset Render Path To Project Settings", exact: true }).click();
  await expect(path).toBeDisabled();
  await expect(path.locator('[data-slot="select-value"]')).toHaveText("Clustered Forward");
  await saveAllIfEnabled(page, 30_000);

  await openTestProject(page);
  await openMainScene(page);
  await page.getByRole("button", { name: "Rendering", exact: true }).click();
  await expect(page.getByTestId("scene-render-path")).toBeDisabled();
  await expect(page.getByTestId("scene-render-path").locator('[data-slot="select-value"]')).toHaveText("Clustered Forward");
  await page.screenshot({ path: testInfo.outputPath("scene-pipeline-inherited.png") });
  await openRendering(page);
  await expect(page.getByTestId("project-render-path").locator('[data-slot="select-value"]')).toHaveText("Clustered Forward");
  await expect(page.getByTestId("project-gpu-backend").locator('[data-slot="select-value"]')).toHaveText("WebGPU");
  await expect(page.getByTestId("setting-render-mode").locator('[data-slot="select-value"]')).toHaveText("PBR");
  await choose(page, "project-render-path", "Auto");
  await choose(page, "project-gpu-backend", "Auto");
  await expect(page.getByTestId("project-render-pipeline-status")).toContainText("Forward · WebGL2");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  await waitForSceneViewportReady(page);
  await expect(page.getByTestId("scene-render-path").locator('[data-slot="select-value"]')).toHaveText("Auto");
  expect(errors).toEqual([]);
});
