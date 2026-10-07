import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { GameSessionState } from "../apps/editor/src/services/game-session-owner";
import type { EngineSceneDiagnostics } from "../apps/editor/src/testing/webgpu-previews-proof";
import { MAIN_SCENE_FILE, type SerializedScene } from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, openTestProject } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { previewPhysicsScene, previewPlacementScene } from "./preview-scene-fixture";
import { readSaveAllDiagnostics } from "./save-all";
import { simulationParticleProject } from "./simulation-particle-fixture";

type RuntimeVisual = { slotId: number; name: string; visible: boolean; position: number[] };
type TestHost = typeof globalThis & {
  __babylonslateSimulationTest: { start(): Promise<void>; state(): GameSessionState };
  __babylonslatePlayTest: {
    tickIndex(): number;
    runtimeMode(): string | null;
    actorPositions(): { slotId: number; x: number; y: number; z: number }[];
    visuals(): RuntimeVisual[];
  };
  __babylonslateTest: {
    activeSceneContent(): SerializedScene | null;
    readAssetChunk(path: string, chunkId: string): Promise<Uint8Array | null>;
    injectTestGamepad(pad: { index: number; axes: number[]; buttons: number[] } | null): void;
  };
  __babylonslateViewportTest: { engineSceneDiagnostics(): Promise<EngineSceneDiagnostics | null> };
  __babylonslateParticleStats?: { systems: number; playing: number; gpuSystems: number };
};

async function state(page: Page) {
  return page.evaluate(() => (globalThis as TestHost).__babylonslateSimulationTest.state());
}
async function content(page: Page) {
  return page.evaluate(() => (globalThis as TestHost).__babylonslateTest.activeSceneContent());
}
async function tick(page: Page) {
  return page.evaluate(() => (globalThis as TestHost).__babylonslatePlayTest.tickIndex());
}
async function visuals(page: Page) {
  return page.evaluate(() => (globalThis as TestHost).__babylonslatePlayTest.visuals());
}
async function savedSceneBytes(page: Page) {
  return page.evaluate(async path => {
    const bytes = await (globalThis as TestHost).__babylonslateTest.readAssetChunk(path, "document");
    return bytes ? Array.from(bytes) : null;
  }, MAIN_SCENE_FILE);
}

/** Only launch uses the temporary test entry. Every subsequent action uses editor chrome. */
async function startSimulation(page: Page) {
  const previous = await state(page);
  await page.evaluate(() => (globalThis as TestHost).__babylonslateSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await expect(page.getByTestId("play-overlay")).toHaveCount(1);
  await expect(page.getByTestId("play-canvas")).toBeVisible();
  const viewport = await page.getByTestId("viewport-panel").boundingBox();
  const gameCanvas = await page.getByTestId("play-canvas").boundingBox();
  expect(viewport).not.toBeNull();
  expect(gameCanvas).not.toBeNull();
  expect(gameCanvas!.x).toBeGreaterThanOrEqual(viewport!.x - 1);
  expect(gameCanvas!.y).toBeGreaterThanOrEqual(viewport!.y - 1);
  expect(gameCanvas!.x + gameCanvas!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
  expect(gameCanvas!.y + gameCanvas!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1);
  await expect(page.getByTestId("play-overlay")).toContainText("Discard On Stop");
  await expect.poll(() => state(page)).toMatchObject({ generation: previous.generation + 1, mode: "simulate", lifecycle: "running", quarantined: false });
  await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(2);
}
async function enterEdit(page: Page) {
  const input = page.getByTestId("simulation-input-mode");
  await expect(input).toContainText("Game Input");
  await input.click();
  await expect(input).toContainText("Return To Game");
  await expect(page.getByTestId("simulation-outliner")).toBeVisible();
  await expect(page.getByTestId("simulation-inspector")).toBeVisible();
}
async function pause(page: Page) {
  await page.getByTestId("play-overlay-pause").click();
  await expect(page.getByTestId("play-overlay-pause")).toHaveAccessibleName("Resume");
  await expect.poll(async () => (await state(page)).lifecycle).toBe("paused");
}
async function stopSimulation(page: Page) {
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 30_000 });
  // UI closure is insufficient: idle is admitted only after the native release promise.
  await expect.poll(() => state(page), { timeout: 30_000 }).toMatchObject({ mode: null, lifecycle: "idle", quarantined: false, error: null });
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
}
async function selectRuntimeActor(page: Page, name: string) {
  await page.getByTestId("simulation-outliner").getByText(name, { exact: true }).click();
  await expect(page.getByTestId("simulation-inspector").getByRole("textbox", { name: "Position X", exact: true })).toBeEnabled();
}
async function editRuntimePosition(page: Page, axis: "X" | "Y" | "Z", value: number) {
  const inspector = page.getByTestId("simulation-inspector");
  const field = inspector.getByRole("textbox", { name: `Position ${axis}`, exact: true });
  await field.fill(String(value));
  await field.press("Tab");
  await expect(field).toHaveValue(String(value));
  await expect(inspector.getByRole("status").filter({ hasText: /^Applied$/ }).first()).toBeVisible();
}
async function pauseSamples(page: Page, frames = 30) {
  return page.evaluate(async count => {
    const api = (globalThis as TestHost).__babylonslatePlayTest;
    const samples = [];
    for (let frame = 0; frame < count; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      samples.push({ tick: api.tickIndex(), positions: api.actorPositions() });
    }
    return samples;
  }, frames);
}
async function evidence(page: Page, testInfo: TestInfo, additional: unknown) {
  const owner = await state(page);
  const engine = await page.evaluate(() => (globalThis as TestHost).__babylonslateViewportTest.engineSceneDiagnostics());
  await testInfo.attach("simulation-evidence", {
    body: JSON.stringify({ url: page.url(), browser: testInfo.project.name,
      buildKey: process.env.BL_TEST_BUILD_KEY, owner, engine, additional }),
    contentType: "application/json",
  });
}

test("Simulation hosts real gameplay, edits parent-local transforms while paused, and discards cleanly", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openMinimalTestProject(page);
  await openMainScene(page);
  await setPreviewScene(page, previewPlacementScene());
  const baseline = await content(page);
  const saved = await savedSceneBytes(page);
  expect(saved).not.toBeNull();
  await startSimulation(page);
  const initialTick = await tick(page);
  await expect.poll(() => tick(page)).toBeGreaterThan(initialTick);
  await expect.poll(async () => (await visuals(page)).filter(visual => visual.visible).length).toBeGreaterThanOrEqual(3);
  await enterEdit(page);
  await pause(page);
  const pausedTick = await tick(page);
  await selectRuntimeActor(page, "Child Actor");
  await editRuntimePosition(page, "X", 9);
  // Parent x=-3 and edited local x=9 must produce world x=6, not x=9.
  await expect.poll(async () => (await visuals(page)).some(visual => visual.visible && Math.abs(visual.position[0]! - 6) < 0.001 && Math.abs(visual.position[1]! - 1) < 0.001)).toBe(true);
  expect((await visuals(page)).some(visual => Math.abs(visual.position[0]! + 3) < 0.001)).toBe(true);
  expect(await tick(page)).toBe(pausedTick);
  expect(await content(page)).toEqual(baseline);
  await expect(page.getByTestId("undo-document")).toBeDisabled();
  await testInfo.attach("paused-runtime-edit", { body: await page.screenshot(), contentType: "image/png" });
  await stopSimulation(page);
  expect(await content(page)).toEqual(baseline);
  expect((await readSaveAllDiagnostics(page)).dirty).toEqual([]);
  expect(await savedSceneBytes(page)).toEqual(saved);
  await evidence(page, testInfo, { initialTick, pausedTick, errors, persistedSceneUnchanged: true });
  expect(errors).toEqual([]);
});

test("Simulation discard preserves unsaved authoring content and the existing Undo/Redo step", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await openMinimalTestProject(page);
  await openMainScene(page);
  await setPreviewScene(page, previewPlacementScene());
  const clean = await content(page);
  const saved = await savedSceneBytes(page);
  await page.getByTestId("tree-row-actor:material-actor").click();
  const authoredX = page.getByTestId("scene-details-panel").getByRole("textbox", { name: "Position X", exact: true });
  await authoredX.fill("-7");
  await authoredX.press("Tab");
  await expect.poll(async () => (await content(page))?.actors.find(actor => actor.id === "material-actor")?.transform.position[0]).toBe(-7);
  const before = await content(page);
  const dirtyBefore = (await readSaveAllDiagnostics(page)).dirty;
  expect(dirtyBefore.length).toBeGreaterThan(0);
  await startSimulation(page);
  await enterEdit(page);
  await pause(page);
  await selectRuntimeActor(page, "Material Actor");
  await editRuntimePosition(page, "X", 12);
  await stopSimulation(page);
  expect(await content(page)).toEqual(before);
  expect((await readSaveAllDiagnostics(page)).dirty).toEqual(dirtyBefore);
  expect(await savedSceneBytes(page)).toEqual(saved);
  await page.getByTestId("undo-document").click();
  await expect.poll(() => content(page)).toEqual(clean);
  expect((await readSaveAllDiagnostics(page)).dirty).toEqual([]);
  await page.getByTestId("redo-document").click();
  await expect.poll(() => content(page)).toEqual(before);
  expect((await readSaveAllDiagnostics(page)).dirty).toEqual(dirtyBefore);
  await evidence(page, testInfo, { dirtyBefore, savedSceneUnchanged: true, priorUndoRedoPreserved: true });
});

test("Simulation Edit and Pause neutralize held gamepad input until a fresh transition", async ({ page }) => {
  test.setTimeout(180_000);
  // The normal Empty template supplies the established Move action and actor script.
  await openTestProject(page);
  await openMainScene(page);
  const inject = (axis: number | null) => page.evaluate(value => {
    (globalThis as TestHost).__babylonslateTest.injectTestGamepad(value === null ? null : { index: 0, axes: [value, 0, 0, 0], buttons: [0, 0, 0, 0] });
  }, axis);
  const moveX = async () => Number(await page.getByTestId("play-move-x").getAttribute("data-move-x"));
  await inject(0);
  await startSimulation(page);
  try {
    await inject(0.85);
    await expect.poll(moveX).toBeGreaterThan(0.5);
    await enterEdit(page);
    await expect.poll(moveX).toBe(0);
    await page.getByTestId("simulation-input-mode").click();
    await expect(page.getByTestId("simulation-input-mode")).toContainText("Game Input");
    await expect.poll(moveX).toBe(0);
    // Returning does not reinterpret the original still-held gesture.
    const returnTick = await tick(page);
    await expect.poll(() => tick(page)).toBeGreaterThan(returnTick + 5);
    expect(await moveX()).toBe(0);
    await inject(0);
    const neutralTick = await tick(page);
    await expect.poll(() => tick(page)).toBeGreaterThan(neutralTick + 2);
    await inject(0.85);
    await expect.poll(moveX).toBeGreaterThan(0.5);
    await pause(page);
    await expect.poll(moveX).toBe(0);
    await page.getByTestId("play-overlay-pause").click();
    await expect.poll(async () => (await state(page)).lifecycle).toBe("running");
    await expect.poll(moveX).toBe(0);
    await inject(0);
    const resumedTick = await tick(page);
    await expect.poll(() => tick(page)).toBeGreaterThan(resumedTick + 2);
    await inject(0.85);
    await expect.poll(moveX).toBeGreaterThan(0.5);
    await stopSimulation(page);
  } finally { await inject(null); }
});

test("Simulation freezes real physics while Edit camera redraws and resumes without pause catch-up", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await openMinimalTestProject(page);
  await openMainScene(page);
  await setPreviewScene(page, previewPhysicsScene());
  await startSimulation(page);
  await expect.poll(async () => (await visuals(page)).some(visual => Math.abs(visual.position[2]! + 10.5) < 0.1 && visual.position[1]! < 7.8)).toBe(true);
  await enterEdit(page);
  await pause(page);
  const before = await pauseSamples(page, 2);
  const canvas = page.getByTestId("play-canvas");
  const imageBefore = await canvas.screenshot();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.55, bounds!.y + bounds!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.55, { steps: 8 });
  await page.mouse.up();
  const frozen = await pauseSamples(page);
  expect(frozen.every(sample => sample.tick === before.at(-1)!.tick)).toBe(true);
  expect(frozen.every(sample => JSON.stringify(sample.positions) === JSON.stringify(before.at(-1)!.positions))).toBe(true);
  const imageAfter = await canvas.screenshot();
  expect(imageAfter.equals(imageBefore), "The paused camera must produce a new visible frame").toBe(false);
  await testInfo.attach("paused-edit-camera", { body: imageAfter, contentType: "image/png" });
  await page.getByTestId("play-overlay-pause").click();
  await expect.poll(() => tick(page)).toBeGreaterThan(before.at(-1)!.tick);
  // Sample the first following browser frames: a pause interval must not become
  // hundreds of accumulated fixed steps in one resumed boundary.
  const resumed = await pauseSamples(page, 2);
  expect(resumed[0]!.tick - before.at(-1)!.tick).toBeLessThan(30);
  await stopSimulation(page);
  await evidence(page, testInfo, { pausedTick: before.at(-1)!.tick, resumedTick: resumed[0]!.tick, frozenSamples: frozen.length });
});

test("Simulation releases native scene owners across 20 sequential pause/edit/stop cycles", async ({ page }, testInfo) => {
  test.skip(process.env.BL_SIMULATION_LIFETIME !== "1", "Explicit lifetime qualification; not a routine browser correctness workload.");
  test.setTimeout(15 * 60_000);
  await openMinimalTestProject(page);
  await openMainScene(page);
  await setPreviewScene(page, previewPlacementScene());
  const nativeCounts = () => page.evaluate(async () => {
    const diagnostics = await (globalThis as TestHost).__babylonslateViewportTest.engineSceneDiagnostics();
    if (!diagnostics) return null;
    return { backend: diagnostics.backend, scenes: diagnostics.scenes.length,
      meshes: diagnostics.scenes.reduce((sum, scene) => sum + scene.meshCount, 0),
      cameras: diagnostics.scenes.reduce((sum, scene) => sum + scene.cameras.length, 0),
      shadows: diagnostics.scenes.reduce((sum, scene) => sum + scene.shadowGeneratorCount, 0) };
  });
  // Warm module code and bounded shared caches before choosing a stable baseline.
  await startSimulation(page);
  await enterEdit(page);
  await pause(page);
  await stopSimulation(page);
  const baseline = await nativeCounts();
  expect(baseline).not.toBeNull();
  const cycles = [];
  for (let cycle = 0; cycle < 20; cycle++) {
    await startSimulation(page);
    await enterEdit(page);
    await pause(page);
    await selectRuntimeActor(page, "Child Actor");
    await editRuntimePosition(page, "X", cycle + 3);
    await stopSimulation(page);
    await expect.poll(nativeCounts, { timeout: 30_000 }).toEqual(baseline);
    cycles.push({ cycle: cycle + 1, owner: await state(page), native: await nativeCounts() });
  }
  await evidence(page, testInfo, { baseline, cycles,
    limitation: "Scene/camera/mesh/shadow counts and confirmed release only; this is not a heap, Worker-listener, GPU-byte, or device-performance qualification." });
});

test("Simulation redraws initialized GPU particles without advancing their visible state", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openMinimalTestProject(page, await simulationParticleProject());
  await openMainScene(page);
  await startSimulation(page);
  const stats = () => page.evaluate(() => (globalThis as TestHost).__babylonslateParticleStats ?? null);
  await expect.poll(stats, { timeout: 30_000 }).toMatchObject({ systems: 1, playing: 1 });
  const native = await stats();
  if (native?.gpuSystems !== 1) {
    await evidence(page, testInfo, { native, unqualified: "This browser did not create the GPU particle owner." });
    await stopSimulation(page);
    test.skip(true, "Actual GPU particle support is required; CPU fallback cannot qualify the patched GPU render-only path.");
  }
  const pixels = () => page.getByTestId("play-canvas").evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = 256; copy.height = 144;
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(canvas, 0, 0, 256, 144);
    const rgba = context.getImageData(0, 0, 256, 144).data;
    let redHash = 2166136261;
    let blueHash = 2166136261;
    let red = 0; let blue = 0;
    for (let y = 0; y < 144; y++) for (let x = 0; x < 256; x++) {
      const index = (y * 256 + x) * 4;
      const r = rgba[index]!; const g = rgba[index + 1]!; const b = rgba[index + 2]!;
      // Center strip contains the emitter, never the selected cube's gizmo.
      const isRed = y > 50 && y < 94 && r > 40 && r > g * 2 && r > b * 2;
      const isBlue = b > 40 && b > g * 2 && b > r * 2;
      red += Number(isRed); blue += Number(isBlue);
      redHash = Math.imul(redHash ^ Number(isRed), 16777619);
      blueHash = Math.imul(blueHash ^ Number(isBlue), 16777619);
    }
    return { red, blue, redHash: redHash >>> 0, blueHash: blueHash >>> 0 };
  });
  await expect.poll(async () => (await pixels()).red).toBeGreaterThan(10);
  const moving = await pixels();
  await expect.poll(async () => (await pixels()).redHash).not.toBe(moving.redHash);
  await enterEdit(page);
  await pause(page);
  await selectRuntimeActor(page, "Redraw Control");
  await editRuntimePosition(page, "X", -2.5);
  await pauseSamples(page, 2);
  const frozen = await pixels();
  expect(frozen.red).toBeGreaterThan(10);
  expect(frozen.blue).toBeGreaterThan(10);
  const pausedTick = await tick(page);
  const samples = [];
  for (const x of [-3, -2.5, -3, -2.5, -3, -2.5]) {
    await editRuntimePosition(page, "X", x);
    const previous = samples.at(-1) ?? frozen;
    await expect.poll(async () => (await pixels()).blueHash).not.toBe(previous.blueHash);
    const sample = await pixels();
    expect(sample.redHash, "Completed redraw must preserve visible GPU particle positions").toBe(frozen.redHash);
    expect(await tick(page)).toBe(pausedTick);
    samples.push(sample);
  }
  await testInfo.attach("gpu-particles-paused", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByTestId("play-overlay-pause").click();
  await expect.poll(async () => (await pixels()).redHash).not.toBe(frozen.redHash);
  await stopSimulation(page);
  await expect.poll(stats).toMatchObject({ systems: 0, playing: 0, gpuSystems: 0 });
  await evidence(page, testInfo, { native, pausedTick, frozen, samples, errors,
    limitation: "Pixel reads are explicit correctness evidence, excluded from timing/performance qualification." });
  expect(errors).toEqual([]);
});
