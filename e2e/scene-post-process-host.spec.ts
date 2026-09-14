import { expect, test } from "@playwright/test";
import type { createScenePostProcessHostProof } from "../apps/editor/src/testing/scene-post-process-host-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

type HostProof = Awaited<ReturnType<typeof createScenePostProcessHostProof>>;
declare global {
  interface Window {
    __babylonslateScenePostProcessHostProof: typeof createScenePostProcessHostProof;
    __hostPostProcess: HostProof;
  }
}
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Play and layer graph hosts retain visible output through pending replacement on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU|INVALID_OPERATION|context lost|fatal/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&scenePostProcessHostProof=1");
    await page.waitForFunction(() => typeof window.__babylonslateScenePostProcessHostProof === "function");
    const mask = await page.evaluate(async (backend) => {
      window.__hostPostProcess = await window.__babylonslateScenePostProcessHostProof(backend);
      return window.__hostPostProcess.maskBytes;
    }, backend);
    let release!: () => void;
    let requested = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/__host-numeric-mask.png", async (route) => {
      requested = true;
      await held;
      await route.fulfill({ contentType: "image/png", body: Buffer.from(mask) });
    });
    try {
      const initial = await page.evaluate(() => window.__hostPostProcess.sample());
      await testInfo.attach("initial-layer", { body: JSON.stringify(initial), contentType: "application/json" });
      await page.evaluate(() => window.__hostPostProcess.beginReplacement());
      await expect.poll(() => requested).toBe(true);
      const pending = await page.evaluate(() => window.__hostPostProcess.sample());
      await testInfo.attach("pending-layer", { body: JSON.stringify({ initial, pending }), contentType: "application/json" });
      expect(pending.error).toBeNull(); expect(pending.presented).toBe(false);
      expect(initial.paths).toEqual({ world: true, layer: true });
      expect(pending.interceptedTextures).toBe(1);
      expect(pending.frames).toBeGreaterThan(initial.frames);
      expect(initial.overlay[0]).toBeGreaterThan(100);
      expect(pending.overlay).toEqual(initial.overlay);
      expect(initial.world.slice(0, 3)).toEqual([80, 40, 20]);
      expect(pending.world.slice(0, 3)).toEqual([20, 40, 80]);
      expect(pending.sibling[0]! - initial.sibling[0]!).toBeGreaterThan(50);
      release();
      const replacement = await page.evaluate(() => window.__hostPostProcess.finishReplacement());
      const resized = await page.evaluate(() => window.__hostPostProcess.resize());
      const cleanup = await page.evaluate(() => window.__hostPostProcess.dispose());
      await testInfo.attach("host-post-process", { body: JSON.stringify({ backend, initial, pending, replacement, resized, cleanup }), contentType: "application/json" });
      expect(replacement.presented).toBe(true);
      expect(replacement.overlay[0]).toBe(0); expect(replacement.overlay[2]).toBe(0);
      expect(replacement.overlay[1]).toBeGreaterThan(20);
      expect(resized.overlay).toEqual(replacement.overlay);
      expect(resized.world).toEqual(replacement.world);
      expect(cleanup).toEqual({ scenes: 0, reservedBytes: 0, engineDisposed: false, diagnostics: [] });
      expect(errors).toEqual([]);
    } catch (error) {
      const state = await page.evaluate(() => window.__hostPostProcess.sample()).catch((reason: unknown) => String(reason));
      await testInfo.attach("failed-host-state", { body: JSON.stringify({ state, requested, errors }), contentType: "application/json" });
      throw error;
    } finally {
      release();
      await page.evaluate(() => window.__hostPostProcess.dispose()).catch(() => {});
    }
  });
}
