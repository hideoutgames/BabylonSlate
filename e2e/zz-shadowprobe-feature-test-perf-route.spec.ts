// THROWAWAY probe (revert).
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clickPlayAndWaitForOverlay } from "./play";
import { createFeatureTestProject, openFeatureTestScene, seedEngineSettings, waitForTextureEncodes } from "./feature-test-project";

test.use({ viewport: { width: 1180, height: 788 }, deviceScaleFactor: 1 });
test("FT_World shadow refresh probe", async ({ page }) => {
  test.setTimeout(40 * 60_000);
  await seedEngineSettings(page, (settings) => { settings.debuggerDefaults.overlayConsole = true; });
  await createFeatureTestProject(page);
  await waitForTextureEncodes(page);
  await openFeatureTestScene(page, "world");
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 600_000 });
  await expect.poll(() => page.evaluate(() => (globalThis as any).__hapticPlayTest?.tickIndex() ?? -1), { timeout: 600_000 }).toBeGreaterThan(30);
  await page.waitForTimeout(10_000);
  const out = await page.evaluate(() => {
    const g = globalThis as any;
    const shadows = g.__hapticPlayTest.shadowDiagnostics();
    return {
      unsafe: [...(g.__unsafeCasters ?? new Map()).entries()],
      maps: [...(g.__mapContinuous ?? new Map()).entries()],
      shadows: JSON.stringify(shadows).slice(0, 4000),
      diag: (() => { const d = g.__hapticPlayTest.rendering(); return { shadowPasses: d?.shadowPasses, shadowDrawCalls: d?.shadowDrawCalls }; })(),
    };
  });
  writeFileSync(process.env.PROBE_OUT ?? "/tmp/shadow-probe.json", JSON.stringify(out, null, 2));
});
