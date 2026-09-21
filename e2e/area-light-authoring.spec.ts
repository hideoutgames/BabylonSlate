import { expect, test, type Page } from "@playwright/test";
import type { SerializedScene } from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeRgbaPng } from "../packages/render/src/png-encode";
import type { EngineHandle } from "../packages/render/src/create-engine";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";
import { renderingEvidence } from "./rendering-evidence";

type AuthoringHost = {
  __babylonslateTest: { activeSceneContent(): SerializedScene };
  __babylonslateViewportTest: { renderingBaseline(): { render: ReturnType<EngineHandle["renderDiagnostics"]> } | null };
};
const scene = (page: Page) => page.evaluate(() => (window as unknown as AuthoringHost).__babylonslateTest.activeSceneContent());
const areaBytes = (page: Page) => page.evaluate(() => (window as unknown as AuthoringHost).__babylonslateViewportTest.renderingBaseline()?.render.gpuReservations.categoryBytes.areaLight);

test("rectangular-light authoring, prepared Texture, history, duplication and reopen retain owned resources", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const files = await minimalProjectFiles();
  const payload = { width: 8, height: 8, usage: "emissive", colorSpace: "srgb" };
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set([64, 220, 90, 255], index);
  files.set("assets/emission.babasset", await encodeAssetDocument({ guid: "emission", name: "Emission", type: "Texture", version: 1, payload }, {
    headerPayload: payload, extraChunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: await encodeRgbaPng(8, 8, rgba) }],
  }));
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await page.getByTestId("tree-row-actor:actor-1").click();
  await page.getByTestId("details-add-component").click();
  const catalog = page.getByTestId("add-component-catalog-item-AreaRectLightComponent");
  await expect(catalog).toContainText("Rectangular Area Light");
  await expect(catalog).toContainText("Unshadowed");
  await catalog.click();
  const component = (await scene(page)).actors.find((actor) => actor.id === "actor-1")!.components.find((entry) => entry.classId === "AreaRectLightComponent")!;
  const width = page.getByTestId(`property-actor-1-${component.id}-width`);
  await expect(width).toHaveValue("1");
  await width.fill("2.5"); await width.press("Enter");
  await page.getByTestId("undo-document").click(); await expect(width).toHaveValue("1");
  await page.getByTestId("redo-document").click(); await expect(width).toHaveValue("2.5");
  await expect.poll(() => areaBytes(page)).toBe(65_536);

  await openAssetFromBrowser(page, "assets/emission.babasset");
  await page.getByRole("button", { name: "Prepare Emission", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check Emission Data", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Ready$/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("prepared-emission.png") });
  await openMainScene(page);
  await page.getByTestId("tree-row-actor:actor-1").click();
  await page.getByTestId(`property-actor-1-${component.id}-textureGuid`).click();
  await page.getByTestId("search-item-emission").click();
  await expect.poll(() => areaBytes(page)).toBe(65_536 + 5_592_404);
  await page.getByTestId("tree-row-actor:actor-1").click({ button: "right" });
  await page.getByTestId("outliner-duplicate-actor-1").click();
  const emitters = (await scene(page)).actors.filter((actor) => actor.components.some((entry) => entry.classId === "AreaRectLightComponent"));
  expect(emitters).toHaveLength(2);
  for (const actor of emitters) expect(actor.components.find((entry) => entry.classId === "AreaRectLightComponent")?.properties).toMatchObject({ width: 2.5, textureGuid: "emission", enabled: true });
  await expect.poll(() => areaBytes(page)).toBe(65_536 + 5_592_404);
  await page.getByTestId("tree-row-actor:actor-1").click();
  await page.getByTestId(`component-remove-${component.id}`).click();
  expect((await scene(page)).actors.find((actor) => actor.id === "actor-1")!.components.some((entry) => entry.classId === "AreaRectLightComponent")).toBe(false);
  await expect.poll(() => areaBytes(page)).toBe(65_536 + 5_592_404);
  await page.getByTestId("undo-document").click();
  await expect(width).toHaveValue("2.5");
  await saveAllIfEnabled(page);
  await page.screenshot({ path: testInfo.outputPath("rectangular-light-inspector.png") });

  await openTestProject(page);
  await openMainScene(page);
  const reopened = (await scene(page)).actors.filter((actor) => actor.components.some((entry) => entry.classId === "AreaRectLightComponent"));
  expect(reopened).toEqual(emitters);
  await expect.poll(() => areaBytes(page)).toBe(65_536 + 5_592_404);
  await openAssetFromBrowser(page, "assets/emission.babasset");
  await expect(page.getByRole("button", { name: "Check Emission Data", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
  await testInfo.attach("area-authoring-evidence", { body: JSON.stringify({ evidence: renderingEvidence("e2e/area-light-authoring.spec.ts"), emitterCount: reopened.length }), contentType: "application/json" });
});
