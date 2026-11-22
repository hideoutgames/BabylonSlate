import type { Page } from "@playwright/test";
import { seedEngineSettings } from "./feature-test-project";
import { WEBKIT_SMOKE_TAG } from "./ipad-tag";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, runConsoleCommand } from "./play";
import { expect, test } from "./profile-context";

type RecordsProbe = { recordLinks: number; links: number; bindBufferBase: number };
type PlayHost = {
  __hapticPlayTest?: {
    rendering(): {
      settings?: Record<string, string>;
      presentation?: { drawn: number };
      frameAdmission?: { worldLoading: boolean; pendingPresentations: number };
    } | null;
  };
  __recordsProbe?: RecordsProbe;
};

/**
 * Before the editor boots: every program link, those whose shaders declare the Material record, and every
 * `bindBufferBase` (each record a Material binds), counted on the page's WebGL2 contexts.
 */
async function probeRecords(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: RecordsProbe = { recordLinks: 0, links: 0, bindBufferBase: 0 };
    (globalThis as unknown as PlayHost).__recordsProbe = probe;
    const proto = globalThis.WebGL2RenderingContext?.prototype;
    if (!proto) return;
    const link = proto.linkProgram;
    proto.linkProgram = function (this: WebGL2RenderingContext, program: WebGLProgram) {
      probe.links += 1;
      try {
        if ((this.getAttachedShaders(program) ?? []).some((shader) => (this.getShaderSource(shader) ?? "").includes("HapticMaterial"))) probe.recordLinks += 1;
      } catch {
        /* A lost context: not counted. */
      }
      return link.call(this, program);
    };
    const bind = proto.bindBufferBase;
    proto.bindBufferBase = function (this: WebGL2RenderingContext, ...args: Parameters<WebGL2RenderingContext["bindBufferBase"]>) {
      probe.bindBufferBase += 1;
      return bind.apply(this, args);
    };
  });
}

const play = (page: Page) => page.evaluate(() => {
  const host = globalThis as unknown as PlayHost;
  const rendering = host.__hapticPlayTest?.rendering();
  return {
    worldDebug: rendering?.settings?.["world.debug"] ?? null,
    drawn: rendering?.presentation?.drawn ?? 0,
    loading: !rendering?.frameAdmission || rendering.frameAdmission.worldLoading || rendering.frameAdmission.pendingPresentations > 0,
    probe: { ...host.__recordsProbe! },
  };
});

/** `bindBufferBase` calls per frame the view drew over a second. */
async function bindsPerFrame(page: Page): Promise<number> {
  const before = await play(page);
  await page.waitForTimeout(1_000);
  const after = await play(page);
  expect(after.drawn, "the view draws").toBeGreaterThan(before.drawn);
  return (after.probe.bindBufferBase - before.probe.bindBufferBase) / (after.drawn - before.drawn);
}

/** Waits until the switch has linked its record programs and no program has linked for two seconds. */
async function settleLinks(page: Page, records: boolean): Promise<void> {
  let last = -1, quietSince = Date.now();
  await expect.poll(async () => {
    const { probe } = await play(page);
    if (probe.links !== last) { last = probe.links; quietSince = Date.now(); }
    return (!records || probe.recordLinks > 0) && Date.now() - quietSince >= 2_000;
  }, { timeout: 120_000, intervals: [500] }).toBe(true);
}

/** Distinct colours in the Play canvas: more than a few means the world drew. */
async function canvasColours(page: Page): Promise<number> {
  const shot = (await page.getByTestId("play-canvas").screenshot()).toString("base64");
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const colours = new Set<number>();
    for (let index = 0; index < data.length; index += 4) colours.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!);
    return colours.size;
  }, shot);
}

/**
 * `worlddebug materialrecords` in Play, on the platform's own graphics stack (ANGLE Metal in the WebKit smoke lane): the
 * Basic 3D scene's Materials compile again reading the Material record and the view keeps drawing a picture with no
 * shader, link or uniform buffer error, then switch back. The switch counts as done only when programs declaring the
 * record linked and the frame binds more buffers than before (each Material's record), so a link that quietly fell back
 * to the previous build fails it.
 */
test("Play switches Materials to the Material record and back without shader errors", { tag: WEBKIT_SMOKE_TAG }, async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|ERROR: 0:|program not linked|Unable to compile|uniform buffer|INVALID_(?:ENUM|OPERATION|VALUE|FRAMEBUFFER_OPERATION)|context lost/i.test(message.text()))
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await seedEngineSettings(page, (settings) => { settings.debuggerDefaults.overlayConsole = true; });
  await probeRecords(page);
  await openTestProject(page);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(async () => (await play(page)).loading, { timeout: 120_000, intervals: [500] }).toBe(false);
  await settleLinks(page, false);
  const off = await play(page);
  expect(off.worldDebug).toBe("none");
  expect(off.probe.recordLinks).toBe(0);
  const bindsOff = await bindsPerFrame(page);

  await runConsoleCommand(page, "worlddebug materialrecords on");
  await expect.poll(async () => (await play(page)).worldDebug).toBe("materialrecords on");
  await settleLinks(page, true);
  const bindsOn = await bindsPerFrame(page);
  expect(bindsOn, `binds per frame ${bindsOff} off, ${bindsOn} on`).toBeGreaterThan(bindsOff);
  expect(await canvasColours(page)).toBeGreaterThan(32);

  await runConsoleCommand(page, "worlddebug materialrecords off");
  await expect.poll(async () => (await play(page)).worldDebug).toBe("none");
  await settleLinks(page, false);
  // Back on the plain builds: the records are no longer bound.
  await expect.poll(() => bindsPerFrame(page), { timeout: 60_000 }).toBeLessThan(bindsOn);
  expect(await canvasColours(page)).toBeGreaterThan(32);
  expect(errors).toEqual([]);
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
});
