import { expect, test } from "@playwright/test";
import type { runWebGpuPredictedAdmissionsProof, runWebGpuProof } from "../apps/editor/src/testing/webgpu-proof";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      // Dawn's Windows decoder needs the D3D11 device exposed by ANGLE.
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      // Linux canvas presentation must use Chromium's Vulkan SwiftShader path
      // as well as Dawn. Its GPU pixel tests use this combination so shared
      // images do not cross an incompatible GL compositor during readback.
      ...(process.platform === "linux"
        ? [
            "--enable-features=Vulkan",
            "--use-vulkan=swiftshader",
            "--disable-vulkan-surface",
          ]
        : []),
    ],
  },
});

test("project backend changes rebuild one Engine while preserving scene edits and Play", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const externalShaderRequests: string[] = [];
  await page.route(/https:\/\/cdn\.babylonjs\.com\/.*(?:glslang|twgsl)/, async (route) => {
    externalShaderRequests.push(route.request().url());
    await route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (isGpuFailure(message.type(), message.text())) errors.push(message.text());
  });
  await openMinimalTestProject(page);
  await openMainScene(page);
  await page.getByTestId("outliner-add-actor").click();
  await page.getByTestId("place-actors-item-shape-box").click();
  expect(await page.evaluate(() => (window as unknown as {
    __hapticViewportTest: { commitGizmoNudge(): Promise<boolean> };
  }).__hapticViewportTest.commitGizmoNudge())).toBe(true);
  const position = () => page.evaluate(() => (window as unknown as {
    __hapticTest: { activeSceneActorPosition(): number[] };
  }).__hapticTest.activeSceneActorPosition());
  const moved = await position();
  const baseline = () => page.evaluate(() => (window as unknown as {
    __hapticViewportTest: { renderingBaseline(): { backend: string; engineCount: number; frameCount: number; drawCalls: number } | null };
  }).__hapticViewportTest.renderingBaseline());
  const captures = [];
  for (const backend of ["WebGPU", "WebGL2", "WebGPU"]) {
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    await page.getByTestId("project-gpu-backend").click();
    await page.getByRole("option", { name: backend, exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(async () => (await baseline())?.backend, { timeout: 30_000 }).toBe(backend.toLowerCase());
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("project-rendering-dialog")).toHaveCount(0);
    await expect.poll(async () => (await baseline())?.frameCount).toBeGreaterThan(0);
    expect(await position()).toEqual(moved);
    expect((await baseline())?.engineCount).toBe(1);
    await expect(page.getByTestId("undo-document")).toBeEnabled();
    captures.push(await baseline());
    await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath(`${backend}-${captures.length}.png`) });
  }
  await page.getByTestId("undo-document").click();
  await expect.poll(async () => (await position())[0]).toBeCloseTo(moved[0] - 1.5, 5);
  await page.getByTestId("redo-document").click();
  await expect.poll(position).toEqual(moved);
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __hapticPlayTest?: { tickIndex(): number };
  }).__hapticPlayTest?.tickIndex() ?? 0), { timeout: 30_000 }).toBeGreaterThan(3);
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await waitForSceneViewportReady(page);
  expect((await baseline())?.engineCount).toBe(1);
  await testInfo.attach("project-backend-transitions", { body: JSON.stringify(captures), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(externalShaderRequests).toEqual([]);
});

test("a lost WebGPU device stops Play and Retry restores the viewport on a new Engine", async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openMinimalTestProject(page);
  await openMainScene(page);
  const baseline = () => page.evaluate(() => (window as unknown as {
    __hapticViewportTest: { renderingBaseline(): { backend: string; engineCount: number; frameCount: number } | null };
  }).__hapticViewportTest.renderingBaseline());
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("project-gpu-backend").click();
  await page.getByRole("option", { name: "WebGPU", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(async () => (await baseline())?.backend, { timeout: 30_000 }).toBe("webgpu");
  await waitForSceneViewportReady(page);

  await clickPlayAndWaitForOverlay(page);
  const ticks = () => page.evaluate(() => (window as unknown as {
    __hapticPlayTest?: { tickIndex(): number };
  }).__hapticPlayTest?.tickIndex() ?? 0);
  await expect.poll(ticks, { timeout: 30_000 }).toBeGreaterThan(3);
  // Software WebGPU resolves `device.lost` for a destroyed device the Engine did not dispose.
  expect(await page.evaluate(() => (window as unknown as {
    __hapticViewportTest: { destroyGraphicsDevice(): boolean };
  }).__hapticViewportTest.destroyGraphicsDevice())).toBe(true);

  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 30_000 });
  const dialog = page.getByTestId("project-rendering-dialog");
  await expect(dialog).toContainText("Rendering Update Failed");
  await expect(dialog).toContainText("graphics device was lost");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  // The lost Engine released its view; a new one draws the scene again.
  await expect.poll(async () => (await baseline())?.frameCount ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await waitForSceneViewportReady(page);
  expect(await baseline()).toMatchObject({ backend: "webgpu", engineCount: 1 });
  expect(pageErrors).toEqual([]);
});

test("WebGPU renders native and graph PBR and CEL using native shaders", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      externalRequests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      isGpuFailure(message.type(), message.text())
    )
      errors.push(message.text());
  });
  await page.goto("/?webgpuProof");
  await page.waitForFunction(() => "__hapticWebGpuProof" in window);
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __hapticWebGpuProof: typeof runWebGpuProof;
      }
    ).__hapticWebGpuProof(),
  );
  await testInfo.attach("webgpu-material-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.retainedEngines).toBe(0);
  expect(result.cancelledEngineReleased).toBe(true);
  // A world view on the software adapter never waits for a new variant's render pipeline: a light switching off draws
  // each Material's previous Effect while its pipeline is created asynchronously, as do floors whose spot starts or
  // stops casting shadows (a lost map's sampler takes a placeholder of the declared type, so no GPU validation error),
  // a spawn with a variant nothing compiled stays hidden meanwhile, and a spawn whose Material the load warmed creates
  // no pipeline at all. A new shadow map, the spot's and the sun's first cascaded one, draws once its casters' depth
  // pipelines exist, creating none synchronously, and a spawn into the drawn sun map with a caster depth variant no
  // caster drew is revealed once that pipeline exists, so the map's redraw with it creates none synchronously either.
  const swap = result.variantSwap!;
  expect({
    swap: { done: swap.swap.done, held: swap.swap.held, previous: swap.swap.previousFrames > 0, ...swap.swap.pipelines,
      asynchronous: swap.swap.pipelines.asynchronous > 0 },
    shadowGain: { done: swap.shadowGain.done, held: swap.shadowGain.held, synchronous: swap.shadowGain.pipelines.synchronous },
    sunShadows: { done: swap.sunShadows.done, held: swap.sunShadows.held, synchronous: swap.sunShadows.pipelines.synchronous,
      cascades: swap.sunShadows.cascades },
    shadowLoss: { done: swap.shadowLoss.done, held: swap.shadowLoss.held, previous: swap.shadowLoss.previousFrames > 0,
      synchronous: swap.shadowLoss.pipelines.synchronous },
    spawn: { done: swap.spawn.done, held: swap.spawn.held, hidden: swap.spawn.hiddenFrames > 0, ...swap.spawn.pipelines,
      asynchronous: swap.spawn.pipelines.asynchronous > 0 },
    staged: { done: swap.staged.done, held: swap.staged.held, ...swap.staged.pipelines,
      asynchronous: swap.staged.pipelines.asynchronous > 0 },
    warmSpawn: { done: swap.warmSpawn.done, held: swap.warmSpawn.held, ...swap.warmSpawn.pipelines },
    casterSpawn: { done: swap.casterSpawn.done, held: swap.casterSpawn.held, hidden: swap.casterSpawn.hiddenFrames > 0,
      synchronous: swap.casterSpawn.pipelines.synchronous },
  }, JSON.stringify(swap)).toEqual({
    swap: { done: true, held: 0, previous: true, synchronous: 0, asynchronous: true },
    shadowGain: { done: true, held: 0, synchronous: 0 },
    sunShadows: { done: true, held: 0, synchronous: 0, cascades: 2 },
    shadowLoss: { done: true, held: 0, previous: true, synchronous: 0 },
    spawn: { done: true, held: 0, hidden: true, synchronous: 0, asynchronous: true },
    staged: { done: true, held: 0, synchronous: 0, asynchronous: true },
    warmSpawn: { done: true, held: 0, synchronous: 0, asynchronous: 0 },
    casterSpawn: { done: true, held: 0, hidden: true, synchronous: 0 },
  });
  // After a load rehearsal of the lights' changes (each drawn once behind the loading screen), a point switching off
  // and a spot starting to cast shadows create no pipeline at all.
  const rehearsed = result.rehearsedChanges!;
  expect({
    rehearsed: rehearsed.report.steps > 0 && rehearsed.report.timedOut.length === 0,
    pointOff: { done: rehearsed.pointOff.done, held: rehearsed.pointOff.held, ...rehearsed.pointOff.pipelines },
    spotShadows: { done: rehearsed.spotShadows.done, held: rehearsed.spotShadows.held, ...rehearsed.spotShadows.pipelines },
  }, JSON.stringify(rehearsed)).toEqual({
    rehearsed: true,
    pointOff: { done: true, held: 0, synchronous: 0, asynchronous: 0 },
    spotShadows: { done: true, held: 0, synchronous: 0, asynchronous: 0 },
  });
  // With a geometry pass (temporal anti-aliasing), a spawn with a variant nothing compiled stays hidden until its colour
  // pipelines exist, then is left out of the geometry pass alone, holding no frame, until its geometry pipeline exists;
  // a light switching off keeps the floor's geometry Effect while its colour variant swaps.
  const geometry = result.geometrySpawn!;
  expect({
    geometryPass: geometry.geometryPass, settled: geometry.settled, done: geometry.done, held: geometry.held,
    hidden: geometry.hiddenFrames > 0, leftOut: geometry.leftOutFrames > 0, synchronous: geometry.pipelines.synchronous,
    asynchronous: geometry.pipelines.asynchronous > 0,
    lightOff: { done: geometry.lightOff.done, held: geometry.lightOff.held, geometryKept: geometry.lightOff.geometryKept },
  }, JSON.stringify(geometry)).toEqual({
    geometryPass: true, settled: true, done: true, held: 0, hidden: true, leftOut: true, synchronous: 0, asynchronous: true,
    lightOff: { done: true, held: 0, geometryKept: true },
  });
  expect(result.captures).toHaveLength(4);
  expect(result.previews).toHaveLength(4);
  expect(result.helpers).toHaveLength(6);
  expect(result.shadows).toHaveLength(4);
  expect(result.vertexStreams).toHaveLength(16);
  expect(result.limits?.maxVertexBuffers ?? 0).toBeGreaterThanOrEqual(8);
  {
    const px = (
      entry: { pixelFormat: string },
      pixels: number[],
      x: number,
      y: number,
    ) => {
      const i = (y * 64 + x) * 4;
      // WebGPU readback follows the swap-chain channel order (bgra8unorm).
      const channels =
        entry.pixelFormat === "bgra8unorm" ? [2, 1, 0] : [0, 1, 2];
      return {
        r: pixels[i + channels[0]!]!,
        g: pixels[i + channels[1]!]!,
        b: pixels[i + channels[2]!]!,
      };
    };
    const isGreen = (p: { r: number; g: number; b: number }) =>
      p.g > 150 && p.r < 60 && p.b < 60;
    const isRed = (p: { r: number; g: number; b: number }) =>
      p.r > 150 && p.g < 60 && p.b < 60;
    const isBackground = (p: { r: number; g: number; b: number }) =>
      p.b > 40 && p.r < 30 && p.g < 30;
    const isBlack = (p: { r: number; g: number; b: number }) =>
      p.r < 20 && p.g < 20 && p.b < 20;
    for (const entry of result.vertexStreams) {
      const label = `${entry.backend}/${entry.case}`;
      if (entry.case === "rigid") {
        expect(isGreen(px(entry, entry.pixels!, 32, 32)), label).toBe(true);
      } else if (entry.case === "vertexColor") {
        expect(isRed(px(entry, entry.pixels!, 32, 32)), label).toBe(true);
      } else if (entry.case === "vertexColorMissing") {
        // Fallback draw: black, not the dark blue background.
        expect(isBlack(px(entry, entry.pixels!, 32, 32)), label).toBe(true);
      } else if (entry.case === "sharedMaterial") {
        expect(isRed(px(entry, entry.before!, 13, 32)), `${label} before left`).toBe(true);
        expect(isBlack(px(entry, entry.before!, 51, 32)), `${label} before right`).toBe(true);
        expect(isBlack(px(entry, entry.after!, 13, 32)), `${label} after left`).toBe(true);
        expect(isRed(px(entry, entry.after!, 51, 32)), `${label} after right`).toBe(true);
      } else if (entry.case === "skinned4" || entry.case === "skinned8") {
        expect(isBackground(px(entry, entry.pixels!, 32, 32)), `${label} origin`).toBe(true);
        expect(isGreen(px(entry, entry.pixels!, 51, 32)), `${label} displaced`).toBe(true);
      } else if (entry.case === "instances" || entry.case === "thinInstances") {
        expect(isGreen(px(entry, entry.pixels!, 13, 32)), `${label} left`).toBe(true);
        expect(isGreen(px(entry, entry.pixels!, 51, 32)), `${label} right`).toBe(true);
        expect(isBackground(px(entry, entry.pixels!, 32, 32)), `${label} centre`).toBe(true);
      } else {
        throw new Error(`Unknown vertex stream case ${entry.case}`);
      }
    }
  }
  for (const capture of result.shadows) {
    expect(capture.shadowed).toHaveLength(96 * 72 * 4);
    expect(capture.unshadowed).toHaveLength(96 * 72 * 4);
    for (const half of [0, 1]) {
      let shadowPixels = 0;
      for (let y = 0; y < 72; y++)
        for (let x = half * 48; x < half * 48 + 48; x++) {
          const index = (y * 96 + x) * 4;
          const green = capture.unshadowed[index + 1];
          if (green > 30 && green > capture.unshadowed[index] * 1.4 &&
              green > capture.unshadowed[index + 2] * 1.2 &&
              green - capture.shadowed[index + 1] > 8) shadowPixels++;
        }
      expect(shadowPixels, `${capture.backend}/${capture.mode}/${half} visible sun shadows`).toBeGreaterThan(10);
    }
  }
  for (const capture of result.captures) {
    expect(capture.shaderLanguage).toBe(capture.backend === "webgpu" ? 1 : 0);
    expect(capture.maxTextureSize).toBeGreaterThanOrEqual(64);
    for (const half of [0, 1]) {
      let green = 0;
      for (let y = 0; y < 64; y++)
        for (let x = half * 32; x < half * 32 + 32; x++) {
          const i = (y * 64 + x) * 4;
          if (
            capture.pixels[i + 1] > 30 &&
            capture.pixels[i + 1] > capture.pixels[i] * 1.5
          )
            green++;
        }
      expect(
        green,
        `${capture.backend}/${capture.mode}/${half}`,
      ).toBeGreaterThan(100);
    }
  }
  // Native readback follows each API's origin and swap-chain channel order.
  // Compare the same displayed pixels without hiding texture orientation errors.
  const rgbaTopLeft = (capture: { pixels: number[]; pixelFormat: string; pixelOrigin: string }) => {
    const pixels: number[] = [];
    expect(["rgba8unorm", "bgra8unorm"]).toContain(capture.pixelFormat);
    const channels =
      capture.pixelFormat === "bgra8unorm" ? [2, 1, 0, 3] : [0, 1, 2, 3];
    for (let y = 0; y < 64; y++) {
      const row = capture.pixelOrigin === "bottom-left" ? 63 - y : y;
      for (let x = 0; x < 64; x++)
        for (const channel of channels)
          pixels.push(capture.pixels[(row * 64 + x) * 4 + channel]);
    }
    return pixels;
  };
  for (const kind of ["grid", "bounds", "msdf"]) {
    const reference = result.helpers.find((capture) => capture.backend === "webgl2" && capture.kind === kind)!;
    const actual = result.helpers.find((capture) => capture.backend === "webgpu" && capture.kind === kind)!;
    expect(reference.shaderLanguages.length).toBeGreaterThan(0);
    expect(actual.shaderLanguages.every((language) => language === 1)).toBe(true);
    const expected = rgbaTopLeft(reference);
    const observed = rgbaTopLeft(actual);
    let lit = 0;
    let maxDifference = 0;
    for (let i = 0; i < observed.length; i++) {
      maxDifference = Math.max(maxDifference, Math.abs(observed[i] - expected[i]));
      if (i % 4 === 1 && observed[i] > 20) lit++;
    }
    expect(lit, `${kind} visible helper`).toBeGreaterThan(40);
    expect(maxDifference, `${kind} backend parity`).toBeLessThanOrEqual(2);
  }
  for (const mode of ["pbr", "cel"]) {
    const reference = rgbaTopLeft(
      result.captures.find(
        (capture) => capture.backend === "webgl2" && capture.mode === mode,
      )!,
    );
    const actual = rgbaTopLeft(
      result.captures.find(
        (capture) => capture.backend === "webgpu" && capture.mode === mode,
      )!,
    );
    let maxDifference = 0;
    for (let i = 0; i < reference.length; i++)
      maxDifference = Math.max(
        maxDifference,
        Math.abs(reference[i] - actual[i]),
      );
    expect(maxDifference, `${mode} backend pixel parity`).toBeLessThanOrEqual(
      2,
    );
    // Both texture rows must remain distinct; a solid-color/missing texture
    // fallback could otherwise satisfy backend parity.
    const upperGreen = actual[(24 * 64 + 20) * 4 + 1];
    const lowerGreen = actual[(40 * 64 + 20) * 4 + 1];
    expect(
      Math.abs(upperGreen - lowerGreen),
      `${mode} texture rows`,
    ).toBeGreaterThan(40);
    const previewReference = result.previews.find(
      (capture) => capture.backend === "webgl2" && capture.mode === mode,
    )!.pixels;
    const previewActual = result.previews.find(
      (capture) => capture.backend === "webgpu" && capture.mode === mode,
    )!.pixels;
    let previewDifference = 0;
    for (let i = 0; i < previewReference.length; i++)
      previewDifference = Math.max(
        previewDifference,
        Math.abs(previewReference[i] - previewActual[i]),
      );
    expect(
      previewDifference,
      `${mode} actual preview canvas parity`,
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        previewActual[(24 * 64 + 32) * 4 + 1] -
          previewActual[(40 * 64 + 32) * 4 + 1],
      ),
      `${mode} preview texture rows`,
    ).toBeGreaterThan(40);
  }
});

test("WebGPU admissions a waiting light approaches have their variants and casters' pipelines ready ahead", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (isGpuFailure(message.type(), message.text())) errors.push(message.text());
  });
  await page.goto("/?webgpuProof");
  await page.waitForFunction(() => "__hapticWebGpuPredictedAdmissionsProof" in window);
  const result = await page.evaluate(() =>
    (window as unknown as {
      __hapticWebGpuPredictedAdmissionsProof: typeof runWebGpuPredictedAdmissionsProof;
    }).__hapticWebGpuPredictedAdmissionsProof(),
  );
  await testInfo.attach("webgpu-predicted-admissions", { body: JSON.stringify(result), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(result.retainedEngines).toBe(0);
  // A light that waits within reach of an admission has the Effects it asks for compiled ahead: a spot entering the
  // Forward budget (and a shadowed one, whose standby map comes back with it), one taking a point's shadow map and one
  // taking the first spot map compile no Effect and hold no frame when admitted, its new map's first draw included.
  // Their receivers' render pipelines are still created then, asynchronously, previous variants drawing meanwhile. The
  // casters of a returning standby map and of the first spot map create no pipeline synchronously: a render of the
  // controller's prediction map created theirs ahead, while nothing else creates pipelines ahead. Jumping straight in,
  // the same admissions compile their Effects then, and a new or returning map waits, neutral, for its casters' depth
  // pipelines, which a warm render of it creates asynchronously. A prediction left to expire leaves no pipeline behind.
  const predicted = result.predictedAdmissions;
  const outcome = (admission: (typeof predicted)["forward"]["approached"]) => ({
    admitted: admission.admitted, done: admission.done, mapDrawn: admission.mapDrawn, effects: admission.effectsAtAdmission,
    held: admission.held, synchronous: admission.pipelines.synchronous, asynchronous: admission.pipelines.asynchronous > 0,
  });
  const jumped = (admission: (typeof predicted)["forward"]["jumped"]) => ({
    admitted: admission.admitted, done: admission.done, mapDrawn: admission.mapDrawn, compiled: admission.effectsAtAdmission > 0,
    held: admission.held, synchronous: admission.pipelines.synchronous,
  });
  expect({
    forward: outcome(predicted.forward.approached), standby: outcome(predicted.standby.approached),
    shadow: outcome(predicted.shadow.approached), first: outcome(predicted.first.approached),
    ahead: {
      forward: predicted.forward.approached.effectsAhead > 0 && predicted.forward.approached.pipelinesAhead === 0,
      standby: predicted.standby.approached.effectsAhead > 0 && predicted.standby.approached.pipelinesAhead > 0,
      shadow: predicted.shadow.approached.effectsAhead > 0 && predicted.shadow.approached.pipelinesAhead === 0,
      first: predicted.first.approached.effectsAhead > 0 && predicted.first.approached.pipelinesAhead > 0,
    },
    jumped: {
      forward: jumped(predicted.forward.jumped), standby: jumped(predicted.standby.jumped),
      shadow: jumped(predicted.shadow.jumped), first: jumped(predicted.first.jumped),
    },
    expired: { standby: predicted.standby.expired.pipelinesLeft, first: predicted.first.expired.pipelinesLeft },
  }, JSON.stringify(predicted)).toEqual({
    forward: { admitted: true, done: true, mapDrawn: true, effects: 0, held: 0, synchronous: 0, asynchronous: true },
    standby: { admitted: true, done: true, mapDrawn: true, effects: 0, held: 0, synchronous: 0, asynchronous: true },
    shadow: { admitted: true, done: true, mapDrawn: true, effects: 0, held: 0, synchronous: 0, asynchronous: true },
    first: { admitted: true, done: true, mapDrawn: true, effects: 0, held: 0, synchronous: 0, asynchronous: true },
    ahead: { forward: true, standby: true, shadow: true, first: true },
    jumped: {
      forward: { admitted: true, done: true, mapDrawn: true, compiled: true, held: 0, synchronous: 0 },
      standby: { admitted: true, done: true, mapDrawn: true, compiled: true, held: 0, synchronous: 0 },
      shadow: { admitted: true, done: true, mapDrawn: true, compiled: true, held: 0, synchronous: 0 },
      first: { admitted: true, done: true, mapDrawn: true, compiled: true, held: 0, synchronous: 0 },
    },
    expired: { standby: 0, first: 0 },
  });
});

function isGpuFailure(type: string, message: string): boolean {
  return ["error", "warning"].includes(type) &&
    /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error|No vertex buffer is provided/i.test(message);
}
