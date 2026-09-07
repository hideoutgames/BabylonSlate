import { expect, test } from "@playwright/test";
import { createActor, createDefaultScene, type SerializedScene } from "../packages/core/src/index";
import { createContentBrowserAsset, openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test("M19: camera clip validation, FOV endpoints, and Undo survive Save and reload", async ({ page }) => {
  await openTestProject(page);
  await openMainScene(page);
  const scene: SerializedScene = {
    ...createDefaultScene(),
    actors: [createActor("qa-camera", "QA Camera", {
      components: [{ id: "lens", classId: "CameraComponent", properties: { nearClip: 0.1, farClip: 1000, fieldOfView: 60 } }],
    })],
  };
  await page.evaluate(async (next) => {
    await (globalThis as unknown as { __babylonslateTest: { setActiveSceneContent: (scene: SerializedScene) => Promise<boolean> } })
      .__babylonslateTest.setActiveSceneContent(next);
  }, scene);
  await page.getByTestId("tree-row-actor:qa-camera").click();
  const near = page.getByTestId("property-qa-camera-lens-nearClip");
  const far = page.getByTestId("property-qa-camera-lens-farClip");
  const fov = page.getByTestId("property-qa-camera-lens-fieldOfView");
  await near.fill("1001");
  await near.press("Tab");
  await expect(near).toHaveValue("0.1");
  await far.fill("0.01");
  await far.press("Tab");
  await expect(far).toHaveValue("1000");
  await near.fill("2");
  await near.press("Tab");
  await page.getByTestId("undo-document").click();
  await expect(near).toHaveValue("0.1");
  await page.getByTestId("redo-document").click();
  await expect(near).toHaveValue("2");
  for (const value of ["1", "179"]) {
    await fov.fill(value);
    await fov.press("Tab");
    await expect(fov).toHaveValue(value);
  }
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openMainScene(page);
  await page.getByTestId("tree-row-actor:qa-camera").click();
  await expect(near).toHaveValue("2");
  await expect(far).toHaveValue("1000");
  await expect(fov).toHaveValue("179");
});

test("M34/L27: particle bounds and lifetime normalization are visible after blur and reload", async ({ page }) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "ParticleEmitter", "QAClamp");
  await openAssetFromBrowser(page, "assets/QAClamp.emitter.babasset");
  const capacity = page.getByTestId("property-capacity");
  const prewarm = page.getByTestId("property-preWarmCycles");
  const minLife = page.getByTestId("property-minLifeTime");
  const maxLife = page.getByTestId("property-maxLifeTime");
  await capacity.fill("0");
  await capacity.press("Tab");
  await expect(capacity).toHaveValue("16");
  await prewarm.fill("9999");
  await prewarm.press("Tab");
  await expect(prewarm).toHaveValue("60");
  await minLife.fill("5");
  await minLife.press("Tab");
  expect(Number(await minLife.inputValue())).toBeLessThanOrEqual(Number(await maxLife.inputValue()));
  const lifetime = [await minLife.inputValue(), await maxLife.inputValue()];
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/QAClamp.emitter.babasset");
  await expect(capacity).toHaveValue("16");
  await expect(prewarm).toHaveValue("60");
  expect([await minLife.inputValue(), await maxLife.inputValue()]).toEqual(lifetime);
});
