import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent, MAIN_SCENE_FILE } from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const SCENE_GUID = "00000000-0000-4000-8000-000000000001";

type LoadingObservation = { phases: string[]; stopped: boolean; dialogSeen: boolean; observer: MutationObserver };

async function trackLoading(host: Locator, mode: "Play" | "Preview Build", stop = false) {
  await host.evaluate((_node, { mode, stop }) => {
    const global = globalThis as unknown as { loadingObservation?: LoadingObservation };
    global.loadingObservation?.observer.disconnect();
    const observation: LoadingObservation = { phases: [], stopped: false, dialogSeen: false, observer: new MutationObserver(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="scene-loading-dialog"]');
      const shown = Boolean(dialog && !dialog.closest('[data-closed]') && (!(dialog instanceof HTMLDialogElement) || dialog.open));
      if (shown) observation.dialogSeen = true;
      // Preview Build / player: the authored-layer host only mirrors loading on
      // the player root. Editor Play keeps its scene-loading dialog.
      const phase = mode === "Preview Build"
        ? (document.querySelector<HTMLElement>('[data-testid="player-root"]')?.dataset.sceneLoading === "true"
            ? document.querySelector<HTMLElement>('[data-testid="player-root"]')?.dataset.sceneLoadPhase ?? ""
            : "")
        : shown ? dialog!.querySelector('[data-slot="progress-label"], [role="status"]')?.textContent ?? "" : "";
      if (phase && !observation.phases.includes(phase)) observation.phases.push(phase);
      if (mode === "Play" && stop && !observation.stopped && phase === "Preparing Scene") {
        const button = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Stop");
        if (button) { observation.stopped = true; button.click(); }
      }
    }) };
    observation.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    global.loadingObservation = observation;
  }, { mode, stop });
}

async function observedPhases(host: Locator) {
  return host.evaluate(() => (globalThis as unknown as { loadingObservation: LoadingObservation }).loadingObservation.phases);
}

async function observedDialogSeen(host: Locator) {
  return host.evaluate(() => (globalThis as unknown as { loadingObservation: LoadingObservation }).loadingObservation.dialogSeen);
}

async function boxes(host: Locator) {
  return host.evaluate(() => {
    const global = globalThis as unknown as {
      __babylonslatePlayTest?: { visuals: () => Array<{ visible: boolean }> };
      __babylonslatePlayerTest?: { visuals: () => Array<{ visible: boolean }> };
    };
    return (global.__babylonslatePlayTest ?? global.__babylonslatePlayerTest)?.visuals().filter((visual) => visual.visible).length ?? 0;
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

for (const mode of ["Play", "Preview Build"] as const) {
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
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    if (mode === "Preview Build") {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    } else await clickPlayAndWaitForOverlay(page);
    const host = mode === "Play" ? page.getByTestId("play-overlay") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-root");
    const dialog = mode === "Play" ? page.getByTestId("scene-loading-dialog") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("scene-loading-dialog");
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    if (mode === "Preview Build") await expect(host).toHaveAttribute("data-scene-loading", "false", { timeout: 30_000 });
    const canvas = mode === "Play" ? page.getByTestId("play-canvas") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas");
    await expect.poll(() => renderedPixels(canvas)).toBeGreaterThan(500);
    await expect.poll(() => boxes(host)).toBe(48);
    const meshCount = mode === "Play" ? await host.evaluate(() => (globalThis as unknown as { __babylonslatePlayTest: { liveObjectCounts: () => { meshes: number } } }).__babylonslatePlayTest.liveObjectCounts().meshes) : null;
    if (mode === "Play") await page.getByTestId("play-console-open").click();
    else await page.getByRole("button", { name: "Console", exact: true }).click();
    for (let reload = 0; reload < 2; reload++) {
      await trackLoading(host, mode);
      await page.getByTestId("debug-console-input").fill(`changescene ${SCENE_GUID}`);
      await page.getByTestId("debug-console-submit").click();
      await expect.poll(() => observedPhases(host)).toContain("Preparing Scene");
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      expect(await observedPhases(host)).toContain("Presenting First Frame");
      if (mode === "Preview Build") {
        await expect(host).toHaveAttribute("data-scene-loading", "false", { timeout: 30_000 });
        expect(await observedDialogSeen(host)).toBe(false);
      }
      await expect.poll(() => boxes(host)).toBe(48);
      await expect.poll(() => renderedPixels(canvas)).toBeGreaterThan(500);
      if (meshCount !== null) await expect.poll(() => host.evaluate(() => (globalThis as unknown as { __babylonslatePlayTest: { liveObjectCounts: () => { meshes: number } } }).__babylonslatePlayTest.liveObjectCounts().meshes)).toBe(meshCount);
    }
    await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("debug-console")).toBeHidden();
    await canvas.screenshot({ path: testInfo.outputPath("scene-reloaded.png") });
    if (mode === "Play") await page.getByTestId("play-console-open").click();
    else await page.getByRole("button", { name: "Console", exact: true }).click();
    await trackLoading(host, mode, true);
    const previousLoadId =
      mode === "Preview Build"
        ? await host.getAttribute("data-scene-load-id")
        : null;
    await page.getByTestId("debug-console-input").fill(`changescene ${SCENE_GUID}`);
    await page.getByTestId("debug-console-submit").click();
    if (mode === "Play") await expect(host).toHaveCount(0);
    else {
      // The player owns no Stop control; the host chrome is the only stop path.
      await expect.poll(() => observedPhases(host)).toContain("Preparing Scene");
      // A cached reload can finish before the poll observes it, so the live
      // data-scene-loading flag may already be false again. The mirrored
      // transaction id advancing proves this reload actually ran.
      await expect
        .poll(async () => host.getAttribute("data-scene-load-id"))
        .not.toBe(previousLoadId);
      expect(await observedDialogSeen(host)).toBe(false);
      await page.getByTestId("preview-build-close").click();
      await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
    }
    await waitForSceneViewportReady(page);
    expect(errors).toEqual([]);
  });
}
