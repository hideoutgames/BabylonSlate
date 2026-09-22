import { expect, test, type Page } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// WebGPU is otherwise admitted (software adapter) so that fallback is caused only
// by the injected adapter outcome, not by a host without the API.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Baseline = { backend: string; engineCount: number; frameCount: number } | null;

const scenarios: Array<{ name: string; inject: () => void; reason: RegExp; babylonFailureLogs: number }> = [
  {
    name: "requestAdapter resolves null",
    babylonFailureLogs: 1,
    inject: () => {
      const gpu = navigator.gpu;
      if (!gpu) return;
      Object.defineProperty(gpu, "requestAdapter", { configurable: true, value: async () => null });
    },
    reason: /WebGPU initialization failed: .*adapter.*Using WebGL2\./i,
  },
  {
    name: "requestAdapter rejects",
    babylonFailureLogs: 1,
    inject: () => {
      const gpu = navigator.gpu;
      if (!gpu) return;
      Object.defineProperty(gpu, "requestAdapter", {
        configurable: true,
        value: async () => { throw new Error("Simulated adapter request failure"); },
      });
    },
    reason: /WebGPU initialization failed: .*Simulated adapter request failure.*Using WebGL2\./i,
  },
  {
    name: "navigator.gpu is absent",
    babylonFailureLogs: 0,
    inject: () => {
      Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => undefined });
    },
    reason: /WebGPU initialization failed: WebGPU is unavailable in this browser\. Using WebGL2\./,
  },
];

for (const scenario of scenarios) {
  test(`WebGPU request falls back to a presented WebGL2 scene when ${scenario.name}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    const deadlineMessages: string[] = [];
    const babylonFailureLogs: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      const text = message.text();
      if (/loading deadline|did not become ready|did not present/i.test(text)) deadlineMessages.push(text);
      // Babylon logs the failed initAsync once before rethrowing; a second
      // occurrence would mean a retry the session never authorized.
      if (/A fatal error occurred during WebGPU creation\/initialization/.test(text)) {
        babylonFailureLogs.push(text);
        return;
      }
      if (["error", "warning"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(text)) errors.push(text);
    });
    await page.addInitScript(scenario.inject);
    await openMinimalTestProject(page);
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    expect((await baseline(page))?.backend).toBe("webgl2");

    await selectBackend(page, "WebGPU");
    // The transition must settle on WebGL2 with the project request unchanged.
    await expect.poll(async () => (await baseline(page))?.backend, { timeout: 60_000 }).toBe("webgl2");
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("project-rendering-dialog")).toHaveCount(0);
    const before = (await baseline(page))!.frameCount;
    await expect.poll(async () => (await baseline(page))?.frameCount).toBeGreaterThan(before);
    expect((await baseline(page))?.engineCount).toBe(1);
    expect(await renderedColors(page)).toBeGreaterThan(1);
    await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath("fallback-webgl2.png") });

    // The reason is explicit in Project Settings; the authored request stays WebGPU.
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    await expect(page.getByTestId("project-gpu-backend")).toContainText("WebGPU");
    await expect(page.getByTestId("project-render-pipeline")).toContainText(scenario.reason);
    await page.getByRole("button", { name: "Done", exact: true }).click();

    await clickPlayAndWaitForOverlay(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __babylonslatePlayTest?: { tickIndex(): number };
    }).__babylonslatePlayTest?.tickIndex() ?? 0), { timeout: 30_000 }).toBeGreaterThan(3);
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await waitForSceneViewportReady(page);
    expect((await baseline(page))?.engineCount).toBe(1);
    expect(deadlineMessages).toEqual([]);
    expect(babylonFailureLogs).toHaveLength(scenario.babylonFailureLogs);
    expect(errors).toEqual([]);
  });
}

async function selectBackend(page: Page, backend: string): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("project-gpu-backend").click();
  await page.getByRole("option", { name: backend, exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

function baseline(page: Page): Promise<Baseline> {
  return page.evaluate(() => (window as unknown as {
    __babylonslateViewportTest?: { renderingBaseline(): { backend: string; engineCount: number; frameCount: number } | null };
  }).__babylonslateViewportTest?.renderingBaseline() ?? null);
}

function renderedColors(page: Page): Promise<number> {
  return page.getByTestId("viewport-canvas").evaluate((element) => {
    const source = element as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext("2d")!;
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < pixels.length; i += 16)
      colors.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
    return colors.size;
  });
}
