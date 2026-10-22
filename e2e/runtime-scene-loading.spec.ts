import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent, MAIN_SCENE_FILE } from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";

const SCENE_GUID = "00000000-0000-4000-8000-000000000001";

type LoadingObservation = { phases: string[]; stopped: boolean; observer: MutationObserver };

async function trackLoading(host: Locator, stop = false) {
  await host.evaluate((_node, stop) => {
    const global = globalThis as unknown as { loadingObservation?: LoadingObservation };
    global.loadingObservation?.observer.disconnect();
    const observation: LoadingObservation = { phases: [], stopped: false, observer: new MutationObserver(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="scene-loading-dialog"]');
      const shown = Boolean(dialog && !dialog.closest('[data-closed]') && (!(dialog instanceof HTMLDialogElement) || dialog.open));
      const phase = shown ? dialog!.querySelector('[data-slot="progress-label"], [role="status"]')?.textContent ?? "" : "";
      if (phase && !observation.phases.includes(phase)) observation.phases.push(phase);
      if (stop && !observation.stopped && phase === "Preparing Scene") {
        const button = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Stop");
        if (button) { observation.stopped = true; button.click(); }
      }
    }) };
    observation.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    global.loadingObservation = observation;
  }, stop);
}

async function observedPhases(host: Locator) {
  return host.evaluate(() => (globalThis as unknown as { loadingObservation: LoadingObservation }).loadingObservation.phases);
}

async function boxes(host: Locator) {
  return host.evaluate(() => {
    const global = globalThis as unknown as {
      __hapticPlayTest?: { visuals: () => Array<{ visible: boolean }> };
    };
    return global.__hapticPlayTest?.visuals().filter((visual) => visual.visible).length ?? 0;
  });
}

async function renderedPixels(canvas: Locator) {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 100) count++;
    return count;
  });
}

// Preview Build scene loading is not part of this CI journey.
for (const mode of ["Play"] as const) {
  test(`${mode} paints repeated Scene Loading transitions and Stop cancels the next reload`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && /Scene loading failed|Unable to compile|CONTEXT_LOST/i.test(message.text())) errors.push(message.text()); });
    const files = await minimalProjectFiles();
    const scene = createDefaultScene();
    scene.settings.environmentTextureGuid = null;
    scene.settings.environmentColor = [0, 0, 0];
    scene.settings.grid.showGrid = false;
    scene.settings.shadowOverrides = { enabled: false };
    scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
    scene.actors[0]!.transform.position = [0, 1.5, -10];
    scene.actors[0]!.transform.rotation = [0, 0, 0, 1];
    scene.actors.push(createActor("fill", "Fill", { components: [{ id: "fill-light", classId: "HemisphericFillLightComponent", properties: { intensity: 1, color: [1, 1, 1], groundColor: [1, 1, 1] } }] }));
    for (let i = 0; i < 48; i++) scene.actors.push(createActor(`box-${i}`, `Box ${i}`, {
      transform: { position: [(i % 8) * 0.6 - 2.1, Math.floor(i / 8) * 0.6, 0], rotation: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4] },
      components: [createMeshComponent(`mesh-${i}`, "box")],
    }));
    files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: SCENE_GUID, type: "Scene", name: "Main", version: createDefaultMigrationRegistry().currentVersion("Scene"), payload: scene as unknown as Record<string, unknown> }));
    await openMinimalTestProject(page, files);
    await showOverlayButtons(page, ["console"]);
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    await clickPlayAndWaitForOverlay(page);
    const host = page.getByTestId("play-overlay");
    const dialog = page.getByTestId("scene-loading-dialog");
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const canvas = page.getByTestId("play-canvas");
    await expect.poll(() => renderedPixels(canvas)).toBeGreaterThan(500);
    await expect.poll(() => boxes(host)).toBe(48);
    const meshCount = await host.evaluate(() => (globalThis as unknown as { __hapticPlayTest: { liveObjectCounts: () => { meshes: number } } }).__hapticPlayTest.liveObjectCounts().meshes);
    await page.getByTestId("play-console-open").click();
    for (let reload = 0; reload < 2; reload++) {
      await trackLoading(host);
      await page.getByTestId("debug-console-input").fill(`changescene ${SCENE_GUID}`);
      await page.getByTestId("debug-console-submit").click();
      await expect.poll(() => observedPhases(host)).toContain("Preparing Scene");
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect.poll(() => observedPhases(host), { timeout: 30_000 }).toContain("Presenting First Frame");
      await expect.poll(() => boxes(host)).toBe(48);
      await expect.poll(() => renderedPixels(canvas)).toBeGreaterThan(500);
      await expect.poll(() => host.evaluate(() => (globalThis as unknown as { __hapticPlayTest: { liveObjectCounts: () => { meshes: number } } }).__hapticPlayTest.liveObjectCounts().meshes)).toBe(meshCount);
    }
    await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("debug-console")).toBeHidden();
    await canvas.screenshot({ path: testInfo.outputPath("scene-reloaded.png") });
    await page.getByTestId("play-console-open").click();
    await trackLoading(host, true);
    await page.getByTestId("debug-console-input").fill(`changescene ${SCENE_GUID}`);
    await page.getByTestId("debug-console-submit").click();
    // The loading dialog's Stop ends Play during the next reload.
    await expect(host).toHaveCount(0);
    await waitForSceneViewportReady(page);
    expect(errors).toEqual([]);
  });
}
