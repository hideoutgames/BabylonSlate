import { expect, test, type Page } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent } from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";

async function useCamera(page: Page, id: string) {
  await page.getByTestId("play-inspector-toggle").click();
  const inspector = page.getByTestId("debug-inspect");
  await inspector.getByTestId(`tree-row-${id}`).click();
  await inspector.getByRole("button", { name: "Use Camera", exact: true }).click();
  await expect(inspector.getByRole("status")).toContainText(id);
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
}

test("Play shadow allocation follows camera possession and returns to the original nearby light", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /shader|ERROR: 0:|context lost/i.test(message.text())) errors.push(message.text());
  });
  await openMinimalTestProject(page);
  await openMainScene(page);
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0.1, 0.1, 0.1];
  scene.settings.grid.showGrid = false;
  scene.settings.shadowOverrides = { enabled: true, localLightMode: "manual", maxLocalLights: 1, localMapSize: 256 };
  scene.actors = [-20, 20].flatMap((x, index) => [
    createActor(`camera-${index}`, `Camera ${index}`, {
      transform: { position: [x, 2, -10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ id: `camera-${index}-lens`, classId: "CameraComponent", properties: {} }],
    }),
    createActor(`light-${index}`, `Light ${index}`, {
      transform: { position: [x, 4, -4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      // The farther light starts brighter; shadow selection must follow distance.
      components: [{ id: `light-${index}-source`, classId: "LightComponent", properties: { lightKind: "point", intensity: index === 0 ? 1 : 3, range: 100, castShadows: true } }],
    }),
    createActor(`box-${index}`, `Box ${index}`, {
      transform: { position: [x, 1, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
      components: [createMeshComponent(`box-${index}-mesh`, "box")],
    }),
  ]);
  scene.settings.mainCameraActorId = "camera-0";
  scene.settings.mainCameraComponentId = "camera-0-lens";
  await setPreviewScene(page, scene);
  await clickPlayAndWaitForOverlay(page);
  await page.getByTestId("play-console-open").click();
  await page.getByTestId("debug-console-input").fill("lightsdebug on");
  await page.getByTestId("debug-console-submit").click();
  await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
  const overlay = page.getByTestId("lights-debug-overlay");
  await expect(overlay).toBeVisible();
  const lightNames = await page.evaluate(() => {
    const poses = (globalThis as unknown as { __babylonslatePlayTest: { actorPositions: () => Array<{ slotId: number; x: number; y: number; z: number }> } }).__babylonslatePlayTest.actorPositions();
    return [-20, 20].map((x) => {
      const light = poses.find((pose) => pose.x === x && pose.y === 4 && pose.z === -4);
      if (!light) throw new Error(`No realized light at ${x}`);
      return `authoredLight:${light.slotId}`;
    });
  });
  const captures: Array<{ camera: number; diagnostics: string }> = [];
  for (const index of [0, 1, 0, 1]) {
    await useCamera(page, `camera-${index}`);
    await expect.poll(async () => {
      const lines = (await overlay.innerText()).split("\n");
      return lines.filter((line) => line.includes("shadows active")).map((line) => line.split(": illumination")[0]);
    }, { timeout: 15_000 }).toEqual([lightNames[index]]);
    const diagnostics = await overlay.innerText();
    expect(diagnostics).toContain("256px / 6 passes");
    expect(diagnostics).toContain(`${lightNames[1 - index]}: illumination active; shadows budget-limited`);
    captures.push({ camera: index, diagnostics });
    await page.getByTestId("play-canvas").screenshot({ path: testInfo.outputPath(`camera-${index}-${captures.length}.png`) });
  }
  await testInfo.attach("camera-shadow-handoff", { body: JSON.stringify(captures), contentType: "application/json" });
  expect(errors).toEqual([]);
  await page.getByTestId("play-overlay-close").click();
});
