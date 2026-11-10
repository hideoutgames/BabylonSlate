import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { expect, test } from "./profile-context";

type PlayHost = {
  __hapticPlayTest?: {
    rendering(): { frameAdmission?: { worldLoading: boolean; pendingPresentations: number } } | null;
    presentedImage(): Promise<{ blackShare: number; meanLevel: number } | null>;
    stubWebGlDraws(on: boolean): boolean;
  };
};

/**
 * A Feature Test Check measures a frame's CPU time with the game view's draws, clears and uniform uploads turned into
 * no-ops (`webgl-draw-stub.ts`). The game must come out of it as it went in: the same picture once it draws again, and
 * a context that raised no error, since everything that binds or uploads stayed real meanwhile.
 */
test("stubbing the game view's draws, as a Check's measurement does, leaves its picture and context as they were", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // The picture samples read pixels back, which the driver notes as a performance message: not an error.
    if (["warning", "error"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|INVALID_(OPERATION|VALUE|ENUM|FRAMEBUFFER_OPERATION)|ERROR: 0:|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  });
  await openTestProject(page);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(() => page.evaluate(() => {
    const admission = (globalThis as unknown as PlayHost).__hapticPlayTest?.rendering()?.frameAdmission;
    return admission ? !admission.worldLoading && admission.pendingPresentations === 0 : false;
  }), { timeout: 60_000 }).toBe(true);
  const image = () => page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest!.presentedImage());
  const stub = (on: boolean) => page.evaluate((on) => (globalThis as unknown as PlayHost).__hapticPlayTest!.stubWebGlDraws(on), on);
  const before = (await image())!;
  // The scene is on screen: a black picture would compare equal to anything that went wrong.
  expect(before.blackShare).toBeLessThan(0.9);
  expect(await stub(true)).toBe(true);
  // Frames keep running without their draws. What the canvas shows meanwhile is the browser's to decide (the last
  // frame it composited, or an emptied drawing buffer), so the picture is compared once the view draws again.
  await page.waitForTimeout(1_500);
  expect(await stub(false)).toBe(true);
  await page.waitForTimeout(1_000);
  const after = (await image())!;
  expect(Math.abs(after.meanLevel - before.meanLevel)).toBeLessThan(2);
  expect(Math.abs(after.blackShare - before.blackShare)).toBeLessThan(0.01);
  // Nothing left to end.
  expect(await stub(false)).toBe(false);
  expect(errors).toEqual([]);
});
