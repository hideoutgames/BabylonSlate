import { expect, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
} from "../packages/core/src/index";
import { openMainScene, openTestProject, waitForSceneViewportReady } from "./open-test-project";

type Presentation = { direct?: boolean; held: number; drawn: number };
type Baseline = { backend?: string; render?: { presentation?: Presentation } };
type Sample = { source: "engine" | "view"; minAlpha: number; spread: number; width: number };
type Probe = { stop: () => Promise<Sample[]> };
type Backend = "webgl2" | "webgpu";

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
  return page.evaluate(() => (
    globalThis as unknown as { __babylonslateViewportTest: { renderingBaseline: () => Baseline | null } }
  ).__babylonslateViewportTest.renderingBaseline());
}

async function presentation(page: Page): Promise<Presentation | undefined> {
  return (await baseline(page))?.render?.presentation;
}

/**
 * Samples what the viewport shows after every Engine frame and after every
 * layout resize: the Engine canvas while it covers the view canvas, else the
 * view canvas. A blank image is transparent or a single flat colour.
 *
 * A page reads a WebGPU canvas back only in the task that acquired its
 * texture, which a held frame never does. On WebGPU the probe therefore reads
 * the covered view canvas: test builds first write the presented image into it
 * (`installDirectViewReadSync`), which copies the held texture to the Engine
 * canvas in this task and draws it from there.
 */
async function startFrameProbe(page: Page, backend: Backend): Promise<Probe> {
  await page.evaluate((readView) => {
    const probe = { samples: [] as Sample[], stop: false };
    window.__directPresentationProbe = probe;
    const engine = document.querySelector<HTMLCanvasElement>('[data-testid="project-engine-canvas"]')!;
    const view = document.querySelector<HTMLCanvasElement>('[data-testid="viewport-canvas"]')!;
    const sampler = document.createElement("canvas");
    sampler.width = sampler.height = 16;
    const context = sampler.getContext("2d", { willReadFrequently: true })!;
    const sample = () => {
      const covered = engine.style.visibility === "visible" && engine.previousElementSibling === view;
      const shown = covered && !readView ? engine : view;
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
      probe.samples.push({ source: covered ? "engine" : "view", minAlpha, spread: high - low, width: shown.width });
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
  }, backend === "webgpu");
  return {
    stop: () => page.evaluate(() => {
      const probe = window.__directPresentationProbe!;
      probe.stop = true;
      return probe.samples;
    }),
  };
}

/**
 * The composited viewport, sampled once from a screenshot: the luma spread of
 * a 16×16 reduction. Screenshots of a visible WebGPU canvas take seconds on the
 * software adapter and stall under continuous heavy rendering, so this is a
 * single check, taken before the probed changes.
 */
async function screenSpread(page: Page): Promise<number> {
  const png = (await page.getByTestId("viewport-canvas").screenshot({ timeout: 60_000 })).toString("base64");
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const sampler = document.createElement("canvas");
    sampler.width = sampler.height = 16;
    const context = sampler.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    let low = 255;
    let high = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luma = (2 * pixels[index]! + 5 * pixels[index + 1]! + pixels[index + 2]!) / 8;
      low = Math.min(low, luma);
      high = Math.max(high, luma);
    }
    return high - low;
  }, png);
}

async function switchToWebGpu(page: Page) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("project-gpu-backend").click();
  await page.getByRole("option", { name: "WebGPU", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(async () => (await baseline(page))?.backend, { timeout: 30_000 }).toBe("webgpu");
  await waitForSceneViewportReady(page);
}

/**
 * Opens the test project's main scene (switched to WebGPU when asked), then
 * requires the directly presented viewport to stay non-blank across the held
 * frames of a FrameGraph rebuild and across a resize.
 */
export async function directViewportStaysNonBlank(page: Page, backend: Backend) {
  await openTestProject(page);
  await openMainScene(page);
  if (backend === "webgpu") await switchToWebGpu(page);
  await page.evaluate(
    (scene) =>
      (
        globalThis as unknown as {
          __babylonslateTest: { setActiveSceneContent: (scene: SerializedScene) => Promise<boolean> };
        }
      ).__babylonslateTest.setActiveSceneContent(scene),
    boxScene(),
  );
  await expect(page.getByTestId("tree-row-actor:probe-box")).toBeVisible();
  await expect.poll(async () => (await presentation(page))?.direct).toBe(true);
  // On screen, the copied canvas texture is what the browser composites.
  if (backend === "webgpu") expect(await screenSpread(page), "the composited viewport is not blank").toBeGreaterThanOrEqual(8);
  const probe = await startFrameProbe(page, backend);

  // A render mode change rebuilds the FrameGraph asynchronously; its frames are held.
  // A software adapter on a loaded host can take seconds per frame.
  const frames = { timeout: 30_000 };
  const before = (await presentation(page))!;
  await page.evaluate(() => (
    globalThis as unknown as { __babylonslateViewportTest: { setRenderSettings: (settings: { mode: "cel" }) => void } }
  ).__babylonslateViewportTest.setRenderSettings({ mode: "cel" }));
  await expect.poll(async () => (await presentation(page))!.held, frames).toBeGreaterThan(before.held);
  const afterHeld = (await presentation(page))!;
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(afterHeld.drawn);

  const viewport = page.viewportSize()!;
  const canvas = page.getByTestId("viewport-canvas");
  const width = (await canvas.boundingBox())!.width;
  await page.setViewportSize({ width: viewport.width - 240, height: viewport.height - 120 });
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(width - 100);
  const afterResize = (await presentation(page))!;
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(afterResize.drawn + 5);
  expect((await presentation(page))!.direct).toBe(true);

  const samples = await probe.stop();
  expect(samples.length).toBeGreaterThan(20);
  expect(new Set(samples.map((sample) => sample.width)).size, "the probe saw the resize").toBeGreaterThan(1);
  const blank = samples.filter((sample) => sample.minAlpha < 250 || sample.spread < 8);
  expect(blank, JSON.stringify(samples.slice(0, 40))).toEqual([]);
}
