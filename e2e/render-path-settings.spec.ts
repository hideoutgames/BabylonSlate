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
  const trigger = page.getByTestId(id);
  await trigger.click();
  await page.getByRole("option", { name, exact: true }).click();
  // A closing menu can still expose an identically named option to the next click.
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(trigger.locator('[data-slot="select-value"]')).toHaveText(name);
}

test("pipeline preferences are project-wide, retained through reopen, and absent from Scene Details", async ({ page }, testInfo) => {
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
  // Render Path is a project setting only: Scene Details has no Rendering
  // override section and no per-Scene path or backend control.
  await expect(page.getByRole("button", { name: "Rendering", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("scene-render-path")).toHaveCount(0);
  await expect(page.getByTestId("scene-render-pipeline")).toHaveCount(0);
  await expect(page.getByTestId("project-gpu-backend")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("scene-details-without-pipeline.png") });
  await saveAllIfEnabled(page, 30_000);

  await openTestProject(page);
  await openMainScene(page);
  await expect(page.getByTestId("scene-render-path")).toHaveCount(0);
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
  await openRendering(page);
  await expect(page.getByTestId("project-render-path").locator('[data-slot="select-value"]')).toHaveText("Auto");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(errors).toEqual([]);
});
