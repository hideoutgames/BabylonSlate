import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  MAIN_SCENE_FILE,
} from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import {
  openMainScene,
  openTestProject,
  waitForSceneViewportReady,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function openRendering(page: Page) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
}
async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
const value = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).locator('[data-slot="select-value"]');
async function openEnvironment(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Environment Lighting",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
async function commitRendering(page: Page) {
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Project Settings" })).toBeHidden();
  await waitForSceneViewportReady(page);
}

test("scalability updates budgets, persists Custom and preserves independent settings and an admitted Ultra sun", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const files = await minimalProjectFiles();
  const scene = createDefaultScene();
  scene.actors = scene.actors.filter(
    (actor) =>
      actor.id === scene.settings.mainCameraActorId ||
      actor.components.some(
        (component) => component.classId === "LightComponent",
      ),
  );
  scene.actors.push(
    createActor("box", "Box", {
      components: [createMeshComponent("box-mesh", "box")],
    }),
  );
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument({
      guid: "00000000-0000-4000-8000-000000000001",
      type: "Scene",
      name: "Main",
      version: createDefaultMigrationRegistry().currentVersion("Scene"),
      payload: scene as unknown as Record<string, unknown>,
    }),
  );
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await openRendering(page);
  await choose(page, "Overall Quality", "High");
  await choose(page, "Local Shadow Budget Mode", "Manual");
  await page
    .getByLabel("Local Shadow Light Budget", { exact: true })
    .fill("16");
  await page
    .getByLabel("Local Shadow Light Budget", { exact: true })
    .press("Tab");
  await expect(value(page, "Shadows Quality")).toHaveText("Custom");
  await choose(page, "Overall Quality", "Low");
  await expect(value(page, "Local Shadow Budget Mode")).toHaveText("Auto");
  await expect(
    page.getByText(/Current Auto Budget: 1 local shadow lights/),
  ).toBeVisible();
  await choose(page, "Local Shadow Budget Mode", "Manual");
  await expect(
    page.getByLabel("Local Shadow Light Budget", { exact: true }),
  ).toHaveValue("1");
  await choose(page, "Overall Quality", "Ultra");
  await expect(
    page.getByText(/Current Auto Budget: 8 local shadow lights/),
  ).toBeVisible();
  await choose(page, "Render Mode", "CEL");
  await openEnvironment(page);
  await page.getByLabel("Environment Rotation", { exact: true }).fill("45");
  await page.getByLabel("Environment Rotation", { exact: true }).press("Tab");
  await expect(value(page, "Overall Quality")).toHaveText("Ultra");
  await commitRendering(page);
  const readAllocation = () => page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __babylonslateViewportTest: {
            renderingBaseline(): {
              render: {
                shadowPasses: number;
                shadowMapBytes: number;
                qualityLimits: string[];
              };
            };
          };
        }
      ).__babylonslateViewportTest.renderingBaseline().render,
  );
  // Settings commit schedules the renderer update after React closes the dialog.
  // The previous scene can already report ready until that update is applied.
  await expect.poll(async () => (await readAllocation()).shadowPasses).toBe(4);
  const allocation = await readAllocation();
  await testInfo.attach("ultra-shadow-admission", {
    body: JSON.stringify(allocation),
    contentType: "application/json",
  });
  expect(allocation.shadowPasses).toBe(4);
  expect(allocation.shadowMapBytes).toBeGreaterThan(0);
  expect(allocation.shadowMapBytes).toBeLessThanOrEqual(384 * 1024 ** 2);
  await openRendering(page);
  await expect(value(page, "Render Mode")).toHaveText("CEL");
  await openEnvironment(page);
  await expect(
    page.getByLabel("Environment Rotation", { exact: true }),
  ).toHaveValue("45");
  await page.getByLabel("Texture Budget (MiB)", { exact: true }).fill("2000");
  await page.getByLabel("Texture Budget (MiB)", { exact: true }).press("Tab");
  await expect(value(page, "Textures Quality")).toHaveText("Custom");
  await commitRendering(page);
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await saveAllIfEnabled(page, 30_000);
  await openTestProject(page);
  await openMainScene(page);
  await openRendering(page);
  await expect(value(page, "Textures Quality")).toHaveText("Custom");
  await expect(
    page.getByLabel("Texture Budget (MiB)", { exact: true }),
  ).toHaveValue("2000");
  await expect(value(page, "Shadows Quality")).toHaveText("Ultra");
  await choose(page, "Textures Quality", "Medium");
  await expect(
    page.getByLabel("Texture Budget (MiB)", { exact: true }),
  ).toHaveValue("512");
  await expect(value(page, "Render Mode")).toHaveText("CEL");
  await page.screenshot({
    path: testInfo.outputPath("scalability-categories.png"),
  });
  expect(errors).toEqual([]);
});
