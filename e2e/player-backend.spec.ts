import { expect, test } from "@playwright/test";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "../packages/core/src/index.ts";
import { exportGame, PREVIEW_STOP_MESSAGE } from "../packages/exporter/src/index.ts";
import { serveExportFiles } from "./export-static-server";
import { EXPECTED_PREVIEW_ACTOR_POSITIONS, previewPlacementScene } from "./preview-scene-fixture";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

async function playerFiles(baseURL: string, backend: "webgl2" | "webgpu") {
  const packed = await exportGame({
    bundleDebugger: false,
    startupSceneGuid: "backend-scene",
    customResolution: {
      ...DEFAULT_RENDER_PROJECT_SETTINGS, gpuBackend: backend,
      customResolution: true, width: 320, height: 180, blackBars: true,
    },
    scripts: [],
    assets: [{
      guid: "backend-scene", type: "Scene", sceneGuid: "backend-scene",
      bytes: new TextEncoder().encode(JSON.stringify(previewPlacementScene())),
    }],
    playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL).href),
  });
  if (!packed.ok) throw new Error(packed.error);
  return packed.value.files;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`standalone player uses the packed ${backend} backend and presents its scene`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) && /shader|validation|destroyed.*texture|context lost|WebGPU uncaptured/i.test(message.text())) errors.push(message.text());
    });
    await page.route(/https:\/\/cdn\.babylonjs\.com\/.*(?:glslang|twgsl)/, async (route) => {
      external.push(route.request().url());
      await route.abort();
    });
    const server = await serveExportFiles(await playerFiles(baseURL!, backend), { honorRange: true });
    try {
      await page.goto(server.url);
      const root = page.getByTestId("player-root");
      await expect(root).toHaveAttribute("data-effective-backend", backend);
      await expect(root).toHaveAttribute("data-requested-backend", backend);
      await expect(root).toHaveAttribute("data-backend-fallback", "");
      await expect(root).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => {
        const host = window as typeof window & { __babylonslatePlayerTest?: { visuals(): Array<{ visible: boolean; position: [number, number, number] }> } };
        return host.__babylonslatePlayerTest?.visuals().filter((visual) => visual.visible).map((visual) => visual.position).sort((a, b) => a[0] - b[0]);
      })).toEqual(EXPECTED_PREVIEW_ACTOR_POSITIONS);
      // GameInstance ticks and structural visuals exist while shaders still load.
      await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 30_000 });
      const pixels = () => page.getByTestId("player-canvas").evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const copy = document.createElement("canvas");
        copy.width = canvas.width; copy.height = canvas.height;
        const context = copy.getContext("2d")!;
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, copy.width, copy.height).data;
        const colors = new Set<number>();
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 255) opaque++;
          colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
        }
        return { width: copy.width, height: copy.height, colors: colors.size, opaque };
      });
      await expect.poll(async () => (await pixels()).colors).toBeGreaterThan(8);
      const sample = await pixels();
      expect(sample.opaque).toBeGreaterThan(1_000);
      await testInfo.attach("player-backend-presentation", { body: JSON.stringify({ backend, ...sample }), contentType: "application/json" });
      await testInfo.attach("player-canvas", { body: await page.getByTestId("player-canvas").screenshot(), contentType: "image/png" });
      await page.evaluate((type) => window.postMessage({ type }, window.location.origin), PREVIEW_STOP_MESSAGE);
      await expect(root).toHaveAttribute("data-booted", "false");
      const ticks = await root.getAttribute("data-ticks");
      await page.waitForTimeout(200);
      expect(await root.getAttribute("data-ticks")).toBe(ticks);
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      try {
        const canvas = page.getByTestId("player-canvas");
        if (await canvas.count()) {
          const state = await canvas.evaluate((node: HTMLCanvasElement) => {
            const copy = document.createElement("canvas");
            copy.width = node.width; copy.height = node.height;
            const context = copy.getContext("2d")!;
            context.drawImage(node, 0, 0);
            const data = context.getImageData(0, 0, copy.width, copy.height).data;
            const colors = new Set<number>();
            for (let i = 0; i < data.length; i += 4) colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
            return { width: node.width, height: node.height, colors: [...colors].slice(0, 32), colorCount: colors.size,
              root: { ...document.querySelector<HTMLElement>('[data-testid="player-root"]')?.dataset },
              loading: document.querySelector('[data-testid="scene-loading-dialog"]')?.textContent ?? null };
          });
          await testInfo.attach("player-final-state", { body: JSON.stringify({ backend, state, errors, external }), contentType: "application/json" });
          await testInfo.attach("player-final-canvas", { body: await canvas.screenshot(), contentType: "image/png" });
        }
      } finally { await server.close(); }
    }
  });
}

test("Stop during a real WebGPU adapter request releases the late device without booting runtime", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const host = window as typeof window & { __backendCancellation?: { entered: boolean; release(): void; devices: number; destroyed: number } };
    const state = { entered: false, release: () => {}, devices: 0, destroyed: 0 };
    host.__backendCancellation = state;
    const gpu = navigator.gpu;
    const request = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      state.entered = true;
      await new Promise<void>((resolve) => { state.release = resolve; });
      const adapter = await request(...args);
      if (adapter) {
        const createDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (...deviceArgs) => {
          const device = await createDevice(...deviceArgs);
          state.devices++;
          const destroy = device.destroy.bind(device);
          device.destroy = () => { state.destroyed++; destroy(); };
          return device;
        };
      }
      return adapter;
    };
  });
  const server = await serveExportFiles(await playerFiles(baseURL!, "webgpu"), { honorRange: true });
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => (window as typeof window & { __backendCancellation?: { entered: boolean } }).__backendCancellation?.entered);
    await page.evaluate((type) => window.postMessage({ type }, window.location.origin), PREVIEW_STOP_MESSAGE);
    await page.evaluate(() => (window as typeof window & { __backendCancellation?: { release(): void } }).__backendCancellation?.release());
    await expect.poll(() => page.evaluate(() => {
      const state = (window as typeof window & { __backendCancellation?: { devices: number; destroyed: number } }).__backendCancellation!;
      return [state.devices, state.destroyed];
    })).toEqual([1, 1]);
    await expect(page.getByTestId("player-root")).toHaveAttribute("data-booted", "false");
    await expect(page.getByTestId("player-root")).toHaveAttribute("data-ticks", "0");
    expect(await page.evaluate(() => "__babylonslatePlayerTest" in window)).toBe(false);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
