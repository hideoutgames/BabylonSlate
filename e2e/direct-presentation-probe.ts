import { expect, test, type Page } from "@playwright/test";
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
type ViewportHooks = {
  __babylonslateViewportTest: {
    renderingBaseline: () => Baseline | null;
    sceneVisuals: () => Array<{ actorId: string }>;
    setRenderSettings: (settings: { mode: "cel" }) => void;
    holdViewportFrames: (hold: boolean) => Promise<void>;
  };
};
/** The center of a screenshot of the viewport, reduced without smoothing. */
type Screen = { pixels: number[]; spread: number; filled: number; milliseconds: number };

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
  return page.evaluate(() => (globalThis as unknown as ViewportHooks).__babylonslateViewportTest.renderingBaseline());
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
  }, backend === "webgpu");
  return {
    stop: () => page.evaluate(() => {
      const probe = window.__directPresentationProbe!;
      probe.stop = true;
      return probe.samples;
    }),
  };
}

/** Under the Engine canvas, so a transparent Engine canvas shows as this colour on screen. */
const VIEW_FILL = [255, 0, 255] as const;

/**
 * Screenshots the viewport while its frames are held and the GPU is idle, with
 * the view canvas under the Engine canvas filled with `VIEW_FILL`, and reduces
 * the center half (overlays sit at the edges) to 64×64 without smoothing.
 */
async function screen(page: Page, label: string): Promise<Screen> {
  await page.evaluate((fill) => {
    const view = document.querySelector<HTMLCanvasElement>('[data-testid="viewport-canvas"]')!;
    const context = view.getContext("2d")!;
    context.fillStyle = `rgb(${fill.join(",")})`;
    context.fillRect(0, 0, view.width, view.height);
  }, VIEW_FILL);
  const started = Date.now();
  const shot = await page.getByTestId("viewport-canvas").screenshot({ timeout: 60_000 });
  const milliseconds = Date.now() - started;
  const png = shot.toString("base64");
  test.info().annotations.push({ type: "direct-presentation-screenshot", description: `${label}: ${milliseconds} ms` });
  await test.info().attach(`direct presentation ${label}`, { body: shot, contentType: "image/png" });
  const reduced = await page.evaluate(async ({ data, fill }) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const sampler = document.createElement("canvas");
    sampler.width = sampler.height = 64;
    const context = sampler.getContext("2d", { willReadFrequently: true })!;
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, bitmap.width / 4, bitmap.height / 4, bitmap.width / 2, bitmap.height / 2, 0, 0, 64, 64);
    const pixels = Array.from(context.getImageData(0, 0, 64, 64).data);
    let low = 255;
    let high = 0;
    let filled = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const [red, green, blue] = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
      const luma = (2 * red + 5 * green + blue) / 8;
      low = Math.min(low, luma);
      high = Math.max(high, luma);
      if (Math.abs(red - fill[0]) + Math.abs(green - fill[1]) + Math.abs(blue - fill[2]) < 24) filled++;
    }
    return { pixels, spread: high - low, filled };
  }, { data: png, fill: VIEW_FILL });
  return { ...reduced, milliseconds };
}

function meanDifference(a: Screen, b: Screen): number {
  let sum = 0;
  for (let index = 0; index < a.pixels.length; index++) sum += Math.abs(a.pixels[index]! - b.pixels[index]!);
  return sum / a.pixels.length;
}

async function holdFrames(page: Page, hold: boolean) {
  await page.evaluate((value) => (globalThis as unknown as ViewportHooks).__babylonslateViewportTest.holdViewportFrames(value), hold);
}

/**
 * What a directly presented WebGPU viewport shows on screen when frames are
 * held. A page reads a WebGPU canvas back only in the task that acquired its
 * texture, so this screenshots the composited page with frames held and the
 * GPU idle (a visible WebGPU canvas under continuous load stalls screenshots
 * on the software adapter):
 * - while a FrameGraph rebuild holds its first frame, the canvas, which that
 *   frame never acquires, still shows the last coherent image;
 * - after a resize while held, the canvas shows the held image copied back
 *   (a shrink crops it, so it still fills the view).
 */
async function heldFramesStayOnScreen(page: Page, frames: { timeout: number }) {
  await holdFrames(page, true);
  const steady = await screen(page, "steady");
  await holdFrames(page, false);
  expect(steady.spread, "the presented viewport is not blank").toBeGreaterThanOrEqual(8);
  expect(steady.filled, "the Engine canvas covers the view canvas").toBe(0);

  // Hold at the first held frame of a render mode change: that frame drew, but never acquired the canvas.
  const { before, atHold } = await page.evaluate(() => new Promise<{ before: Presentation; atHold: Presentation }>((resolve, reject) => {
    const hooks = (globalThis as unknown as ViewportHooks).__babylonslateViewportTest;
    const before = hooks.renderingBaseline()!.render!.presentation!;
    const deadline = performance.now() + 30_000;
    const watch = () => {
      const now = hooks.renderingBaseline()?.render?.presentation;
      if (now && now.held > before.held) {
        hooks.holdViewportFrames(true).then(() => resolve({ before, atHold: now }), reject);
        return;
      }
      if (performance.now() > deadline) reject(new Error("No frame was held after the render mode change."));
      else requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    hooks.setRenderSettings({ mode: "cel" });
  }));
  const midHold = await screen(page, "mid-hold");
  expect(atHold.drawn, "the first frame after the render mode change was held").toBe(before.drawn);
  expect((await presentation(page))!.drawn, "no frame drew while held").toBe(atHold.drawn);
  expect(midHold.filled, "the Engine canvas still covers the view canvas").toBe(0);
  expect(meanDifference(midHold, steady), "the screen still shows the last coherent image").toBeLessThan(2);
  await holdFrames(page, false);
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(atHold.drawn);

  // Resize while held: the Engine resizes (its canvas clears) and the held image is copied back.
  await holdFrames(page, true);
  const held = (await presentation(page))!;
  const engineWidth = () => page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-testid="project-engine-canvas"]')!.width);
  const widthBefore = await engineWidth();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width - 120, height: viewport.height - 60 });
  await expect.poll(engineWidth, frames).toBeLessThan(widthBefore);
  await holdFrames(page, true);
  const resized = await screen(page, "resized while held");
  expect((await presentation(page))!.drawn, "no frame drew while held").toBe(held.drawn);
  expect(resized.filled, "the restored canvas covers the view canvas").toBe(0);
  expect(resized.spread, "the restored image is not blank").toBeGreaterThanOrEqual(8);
  await holdFrames(page, false);
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(held.drawn);
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
 * frames of a FrameGraph rebuild and across a resize. On WebGPU the held
 * frames are checked on screen (`heldFramesStayOnScreen`), and the per-frame
 * probe covers a further resize.
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
  // A software adapter on a loaded host can take seconds per frame.
  const frames = { timeout: 30_000 };
  // The box scene is drawn: frames that realize it are held, and the screen keeps the previous scene meanwhile.
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as ViewportHooks).__babylonslateViewportTest
    .sceneVisuals().map((visual) => visual.actorId)), frames).toContain("probe-box");
  const realized = (await presentation(page))!;
  await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(realized.drawn + 2);
  if (backend === "webgpu") await heldFramesStayOnScreen(page, frames);
  const probe = await startFrameProbe(page, backend);

  if (backend === "webgl2") {
    // A render mode change rebuilds the FrameGraph asynchronously; its frames are held.
    const before = (await presentation(page))!;
    await page.evaluate(() => (globalThis as unknown as ViewportHooks).__babylonslateViewportTest.setRenderSettings({ mode: "cel" }));
    await expect.poll(async () => (await presentation(page))!.held, frames).toBeGreaterThan(before.held);
    const afterHeld = (await presentation(page))!;
    await expect.poll(async () => (await presentation(page))!.drawn, frames).toBeGreaterThan(afterHeld.drawn);
  }

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
