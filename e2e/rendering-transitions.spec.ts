import { expect, test, type Page } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent } from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";

async function openRenderingSettings(page: Page) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
}

async function select(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

async function trackLoading(page: Page) {
  await page.evaluate(() => {
    const host = globalThis as unknown as {
      loadingCheck?: { phases: string[]; readyWhileLoading: boolean; observer: MutationObserver };
    };
    host.loadingCheck?.observer.disconnect();
    const check = {
      phases: [] as string[],
      readyWhileLoading: false,
      observer: new MutationObserver(() => {
        const dialog = document.querySelector('[data-testid="scene-loading-dialog"]');
        if (!dialog || dialog.closest('[data-closed]')) return;
        const phase = dialog.querySelector('[data-slot="progress-label"]')?.textContent ?? "";
        if (phase && !check.phases.includes(phase)) check.phases.push(phase);
        if (document.querySelector('[data-testid="viewport-panel"]')?.getAttribute("data-scene-ready") === "true") {
          // The success commit can retain the dialog for its exit animation.
          const progress = dialog.querySelector('[data-slot="progress"]');
          if (progress?.getAttribute("aria-valuenow") !== "100") check.readyWhileLoading = true;
        }
      }),
    };
    check.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    host.loadingCheck = check;
  });
}

async function loadingResult(page: Page) {
  return page.evaluate(() => {
    const check = (globalThis as unknown as {
      loadingCheck: { phases: string[]; readyWhileLoading: boolean };
    }).loadingCheck;
    return { phases: check.phases, readyWhileLoading: check.readyWhileLoading };
  });
}

test("settings close and manual reload finish blocking transitions without losing the viewport", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /failed to (create|load) scene|Unable to compile|CONTEXT_LOST/i.test(message.text())) {
      failures.push(message.text());
    }
  });
  await openMinimalTestProject(page);
  await openMainScene(page);
  const scene = createDefaultScene("Rendering Transitions");
  scene.settings.environmentTextureGuid = null;
  scene.actors.push(
    createActor("subject", "Subject", { components: [createMeshComponent("subject-mesh", "box")] }),
    createActor("local-light", "Local Light", {
      transform: { position: [2, 3, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ id: "point", classId: "LightComponent", properties: {
        lightKind: "point", intensity: 2, color: [1, 1, 1], range: 15, castShadows: true,
      } }],
    }),
  );
  await setPreviewScene(page, scene);
  await waitForSceneViewportReady(page);

  for (const [quality, budget, shading] of [["Medium", "4", "PBR"], ["Ultra", "16", "CEL"], ["Low", "16", "PBR"]] as const) {
    await openRenderingSettings(page);
    await select(page, "Overall Quality", quality);
    await select(page, "Local Shadow Budget Mode", "Manual");
    await page.getByLabel("Local Shadow Light Budget", { exact: true }).fill(budget);
    await page.getByLabel("Local Shadow Light Budget", { exact: true }).press("Tab");
    await page.getByTestId("setting-render-mode").click();
    await page.getByRole("option", { name: shading, exact: true }).click();
    await trackLoading(page);
    await page.getByTestId("settings-modal").getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(async () => (await loadingResult(page)).phases).toContain("Preparing Scene");
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("viewport-panel")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("scene-loading-dialog")).toBeHidden();
    const loading = await loadingResult(page);
    expect(loading.phases).toContain("Presenting First Frame");
    expect(loading.readyWhileLoading).toBe(false);
    expect(failures).toEqual([]);
  }

  await openRenderingSettings(page);
  await trackLoading(page);
  await page.getByTestId("settings-modal").getByRole("button", { name: "Done", exact: true }).click();
  // Unchanged settings must remain quiet beyond the 150 ms apply debounce.
  await page.waitForTimeout(250);
  expect((await loadingResult(page)).phases).toEqual([]);
  await waitForSceneViewportReady(page);

  await trackLoading(page);
  await page.getByTestId("viewport-canvas").click({ button: "right" });
  await page.getByTestId("context-menu-item-reload-scene").click();
  await expect.poll(async () => (await loadingResult(page)).phases).toContain("Preparing Scene");
  await waitForSceneViewportReady(page);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden();
  expect((await loadingResult(page)).phases).toContain("Presenting First Frame");
  expect(failures).toEqual([]);
  await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath("reloaded-scene.png") });
});
