import { expect, test } from "@playwright/test";
import { createActor, createDefaultScene } from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";

test("D780: Inspector switches cameras and destroys only the live actor while paused", async ({ page }) => {
  await openTestProject(page);
  await openMainScene(page);
  const scene = createDefaultScene();
  scene.actors = ["camera-a", "camera-b"].map((id, index) => createActor(id, "Camera", {
    transform: { position: [index * 5, 2, -10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ id: `${id}-lens`, classId: "CameraComponent", properties: {} }],
  }));
  scene.settings.mainCameraActorId = "camera-a";
  scene.settings.mainCameraComponentId = "camera-a-lens";
  await setPreviewScene(page, scene);
  await expect(page.getByTestId("tree-row-actor:camera-a")).toContainText("Camera (camera-a)");
  await expect(page.getByTestId("tree-row-actor:camera-b")).toContainText("Camera (camera-b)");
  await clickPlayAndWaitForOverlay(page);
  await page.getByTestId("play-overlay-pause").click();
  await page.getByTestId("play-inspector-toggle").click();
  const dialog = page.getByTestId("debug-inspect");
  await dialog.getByTestId("tree-row-camera-b").click();
  await dialog.getByRole("button", { name: "Use Camera", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("camera-b");
  await dialog.getByRole("button", { name: "Destroy Actor", exact: true }).click();
  await expect(dialog.getByTestId("tree-row-camera-b")).toHaveCount(0);
  await expect(dialog.getByTestId("tree-row-camera-a")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("tree-row-actor:camera-b")).toContainText("Camera (camera-b)");
  await clickPlayAndWaitForOverlay(page);
  await page.getByTestId("play-inspector-toggle").click();
  await expect(dialog.getByTestId("tree-row-camera-b")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("play-overlay-close").click();
});
