import { expect, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
} from "../packages/core/src/index";
import { openMainScene, openTestProject } from "./open-test-project";

type Presentation = { direct?: boolean; held: number; drawn: number };
type Baseline = { render?: { presentation?: Presentation } };
type Sample = { source: "engine" | "view"; minAlpha: number; spread: number; width: number };
type Probe = { stop: () => Promise<Sample[]> };
type ViewportHooks = {
  __hapticViewportTest: {
    renderingBaseline: () => Baseline | null;
    sceneVisuals: () => Array<{ actorId: string }>;
    setRenderSettings: (settings: { mode: "cel" }) => void;
  };
};

declare global {
  interface Window {
    __directPresentationProbe?: { samples: Sample[]; stop: boolean };
  }
}

function boxScene(): SerializedScene {
  const base = createDefaultScene();
  return {
    ...base,
    actors: [
      ...base.actors,
      createActor("probe-box", "Probe Box", {
        transform: identitySerializedTransform(),
        components: [createMeshComponent("probe-box-mesh", "box")],
      }),
    ],
  };
}

async function baseline(page: Page): Promise<Baseline | null> {
  return page.evaluate(() => (globalThis as unknown as ViewportHooks).__hapticViewportTest.renderingBaseline());
}

async function presentation(page: Page): Promise<Presentation | undefined> {
  return (await baseline(page))?.render?.presentation;
}

/**
 * Samples what the viewport shows after every Engine frame and after every
 * layout resize: the Engine canvas while it covers the view canvas, else the
 * view canvas. A blank image is transparent or a single flat colour.
 */
async function startFrameProbe(page: Page): Promise<Probe> {
  await page.evaluate(() => {
    const probe = { samples: [] as Sample[], stop: false };
    window.__directPresentationProbe = probe;
    const engine = document.querySelector<HTMLCanvasElement>('[data-testid="project-engine-canvas"]')!;
    const view = document.querySelector<HTMLCanvasElement>('[data-testid="viewport-canvas"]')!;
    const sampler = document.createElement("canvas");
    sampler.width = sampler.height = 16;
    const context = sampler.getContext("2d", { willReadFrequently: true })!;
    const sample = () => {
      const covered = engine.style.visibility === "visible" && engine.previousElementSibling === view;
      const shown = covered ? engine : view;
      context.clearRect(0, 0, 16, 16);
      context.drawImage(shown, 0, 0, 16, 16);
      const data = context.getImageData(0, 0, 16, 16).data;
      let minAlpha = 255;
      let low = 255;
      let high = 0;
      for (let index = 0; index < data.length; index += 4) {
        minAlpha = Math.min(minAlpha, data[index + 3]!);
        const luma = (2 * data[index]! + 5 * data[index + 1]! + data[index + 2]!) / 8;
        low = Math.min(low, luma);
        high = Math.max(high, luma);
      }
      probe.samples.push({ source: shown === engine ? "engine" : "view", minAlpha, spread: high - low, width: shown.width });
    };
    // Queued now, this callback runs after the Engine's in every frame, so it
    // reads the buffer the browser is about to present.
    const frame = () => {
      if (probe.stop) return;
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Resize observers run after frame callbacks; a resize clears the buffer there.
    const resized = new ResizeObserver(() => { if (!probe.stop) sample(); });
    resized.observe(view);
    resized.observe(engine);
  });
  return {
    stop: () => page.evaluate(() => {
      const probe = window.__directPresentationProbe!;
      probe.stop = true;
      return probe.samples;
    }),
  };
}

/**
 * Opens the test project's main scene, then requires the directly presented
 * viewport to stay non-blank across the held frames of a FrameGraph rebuild
 * and across a resize.
 */
export async function directViewportStaysNonBlank(page: Page) {
  await openTestProject(page);
  await openMainScene(page);
  await page.evaluate(
    (scene) =>
      (
        globalThis as unknown as {
          __hapticTest: { setActiveSceneContent: (scene: SerializedScene) => Promise<boolean> };
        }
      ).__hapticTest.setActiveSceneContent(scene),
    boxScene(),
  );
  await expect(page.getByTestId("tree-row-actor:probe-box")).toBeVisible();
  await expect.poll(async () => (await presentation(page))?.direct).toBe(true);
  // A software adapter on a loaded host can take seconds per frame.
  const frames = { timeout: 30_000 };
  // The box scene is drawn: frames that realize it are held, and the screen keeps the previous scene meanwhile.
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as ViewportHooks).__hapticViewportTest
    .sceneVisuals().map((visual) => visual.actorId)), frames).toContain("probe-box");
  const realized = (await presentation(page))!;
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(realized.drawn + 2);
  const probe = await startFrameProbe(page);

  // A render mode change rebuilds the FrameGraph asynchronously; its frames are held.
  const before = (await presentation(page))!;
  await page.evaluate(() => (globalThis as unknown as ViewportHooks).__hapticViewportTest.setRenderSettings({ mode: "cel" }));
  await expect.poll(async () => (await presentation(page))!.held, frames).toBeGreaterThan(before.held);
  const afterHeld = (await presentation(page))!;
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(afterHeld.drawn);

  const viewport = page.viewportSize()!;
  const canvas = page.getByTestId("viewport-canvas");
  const width = (await canvas.boundingBox())!.width;
  await page.setViewportSize({ width: viewport.width - 240, height: viewport.height - 120 });
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(width - 100);
  const afterResize = (await presentation(page))!;
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(afterResize.drawn + 25);
  expect((await presentation(page))!.direct).toBe(true);

  const samples = await probe.stop();
  expect(samples.length).toBeGreaterThan(20);
  expect(new Set(samples.map((sample) => sample.width)).size, "the probe saw the resize").toBeGreaterThan(1);
  const blank = samples.filter((sample) => sample.minAlpha < 250 || sample.spread < 8);
  expect(blank, JSON.stringify(samples.slice(0, 40))).toEqual([]);
}
