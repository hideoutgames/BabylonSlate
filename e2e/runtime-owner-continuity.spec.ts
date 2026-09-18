import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, MAIN_SCENE_FILE, PROJECT_FILE, type SerializedGraph } from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const WORLD = "00000000-0000-4000-8000-000000000001";
const LAYER = "00000000-0000-4000-8000-000000000031";
const LAYER_CLASS = "00000000-0000-4000-8000-000000000032";
const GAME_CLASS = "00000000-0000-4000-8000-000000000033";

async function filesForContinuity() {
  const files = await minimalProjectFiles();
  const versions = createDefaultMigrationRegistry();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.gameInstanceClass = "LoadingGame";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const game: SerializedGraph = {
    nodes: [
      { id: "first", type: "flow.event.firstSceneLoaded", data: {}, position: { x: 0, y: 0 } },
      { id: "create", type: "scene-layer.create", data: { "default:asset": LAYER, "default:zOrder": 10 }, position: { x: 220, y: 0 } },
    ],
    edges: [{ id: "first-create", source: "first", sourceHandle: "execOut", target: "create", targetHandle: "execIn" }],
  };
  const moving: SerializedGraph = {
    nodes: [
      { id: "tick", type: "flow.event.tick", data: {}, position: { x: 0, y: 0 } },
      { id: "move", type: "debug.executeJavaScript", data: { body: 'const tick = Number(ctx.self.getVariable("ticks") ?? 0) + 1; ctx.self.setVariable("ticks", tick); ctx.setActorLocation(ctx.self, { x: -10 + (tick % 40) * 0.06, y: 3, z: 0 });' }, position: { x: 220, y: 0 } },
    ],
    edges: [{ id: "tick-move", source: "tick", sourceHandle: "execOut", target: "move", targetHandle: "execIn" }],
  };
  for (const [guid, name, payload, parentClass, dependencies] of [
    [GAME_CLASS, "LoadingGame", game, "GameInstance", [LAYER]],
    [LAYER_CLASS, "MovingHud", moving, "SceneLayerActor", []],
  ] as const) files.set(`assets/${name}.class.babasset`, await encodeAssetDocument({ guid, type: "Class", name,
    version: versions.currentVersion("Class"), payload: payload as unknown as Record<string, unknown> }, { parentClass, dependencies: [...dependencies] }));
  const layer = createDefaultSceneLayer();
  layer.actors = [createActor("moving-hud", "Moving HUD", { classId: "MovingHud",
    transform: { position: [-10, 3, 0], rotation: [0, 0, 0, 1], scale: [3, 1.5, 1] },
    components: [{ id: "hud-image", classId: "2DTextureComponent", properties: {} }] })];
  files.set("assets/MovingHud.scenelayer.babasset", await encodeAssetDocument({ guid: LAYER, type: "SceneLayer", name: "Moving HUD",
    version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown> }, { dependencies: [LAYER_CLASS] }));
  const scene = createDefaultScene();
  scene.settings.environmentTextureGuid = null;
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.shadowOverrides = { enabled: false };
  scene.settings.grid.showGrid = false;
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
  scene.actors[0]!.transform.position = [0, 1.5, -10];
  scene.actors[0]!.transform.rotation = [0, 0, 0, 1];
  scene.actors.push(createActor("fill", "Fill", { components: [{ id: "fill-light", classId: "HemisphericFillLightComponent",
    properties: { intensity: 1, color: [1, 1, 1], groundColor: [1, 1, 1] } }] }));
  for (let i = 0; i < 96; i++) scene.actors.push(createActor(`box-${i}`, `Box ${i}`, {
    transform: { position: [(i % 12) * 0.4 - 2.2, Math.floor(i / 12) * 0.4, 0], rotation: [0, 0, 0, 1], scale: [0.3, 0.3, 0.3] },
    components: [createMeshComponent(`mesh-${i}`, "box")],
  }));
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: WORLD, type: "Scene", name: "Main", version: versions.currentVersion("Scene"),
    payload: scene as unknown as Record<string, unknown> }, { dependencies: [GAME_CLASS] }));
  return files;
}

type Sample = { atMs: number; paintHeld: boolean; phase: string; lit: number; hud: number; center: number; hudX: number | null; width: number; height: number };
type Observation = { samples: Sample[]; phases: string[]; resizing: boolean; dialogSeen: boolean; stop: () => void };
type LoadingPaintGate = { held: boolean; workCommands: string[]; arm: () => void; release: () => void };

async function observeCanvas(canvas: Locator) {
  await canvas.evaluate((node: HTMLCanvasElement) => {
    const host = globalThis as unknown as { continuity?: Observation; loadingPaintGate: LoadingPaintGate;
      __babylonslatePlayTest?: { visuals: () => Array<{ visible: boolean; position: number[] }> };
      __babylonslatePlayerTest?: { visuals: () => Array<{ visible: boolean; position: number[] }> } };
    host.continuity?.stop();
    const copy = document.createElement("canvas");
    copy.width = 96; copy.height = 64;
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    context.imageSmoothingEnabled = false;
    let frame = 0;
    const initialWidth = node.style.width;
    const observation: Observation = { samples: [], phases: [], resizing: false, dialogSeen: false,
      stop: () => { cancelAnimationFrame(frame); node.style.width = initialWidth; } };
    const sample = () => {
      // Preview Build / player expose loading on the player root; editor Play
      // keeps its scene-loading dialog.
      const root = document.querySelector<HTMLElement>('[data-testid="player-root"]');
      const dialog = document.querySelector('[data-testid="scene-loading-dialog"]');
      const shown = root
        ? root.dataset.sceneLoading === "true"
        : Boolean(dialog && !dialog.closest("[data-closed]") && (!(dialog instanceof HTMLDialogElement) || dialog.open));
      if (dialog) observation.dialogSeen = true;
      const phase = shown
        ? root
          ? root.dataset.sceneLoadPhase ?? ""
          : dialog!.querySelector('[data-slot="progress-label"], [role="status"]')?.textContent ?? ""
        : "";
      if (phase && !observation.phases.includes(phase)) observation.phases.push(phase);
      // Resize once the loading state is visible; Preparing Scene is a single
      // end-frame window that a per-frame sampler can now miss.
      if (phase && !observation.resizing) {
        observation.resizing = true;
        node.style.width = "94%";
      }
      context.clearRect(0, 0, 96, 64);
      context.drawImage(node, 0, 0, 96, 64);
      const pixels = context.getImageData(0, 0, 96, 64).data;
      let lit = 0, hud = 0, sumX = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 180) lit++;
        if (x < 29 && y < 29 && pixels[i]! > 230 && pixels[i + 1]! > 230 && pixels[i + 2]! > 230) { hud++; sumX += x; }
      }
      const visual = (host.__babylonslatePlayTest ?? host.__babylonslatePlayerTest)?.visuals()
        .find((value) => value.visible && value.position[0]! < -6 && Math.abs(value.position[1]! - 3) < .01);
      observation.samples.push({ atMs: performance.now(), paintHeld: host.loadingPaintGate.held, phase, lit, hud, center: hud ? sumX / hud : 0, hudX: visual?.position[0] ?? null, width: node.width, height: node.height });
      if (observation.samples.length < 3000 && node.isConnected) frame = requestAnimationFrame(sample);
    };
    host.continuity = observation;
    frame = requestAnimationFrame(sample);
  });
}

async function samples(canvas: Locator) {
  return canvas.evaluate(() => (globalThis as unknown as { continuity: Observation }).continuity.samples);
}

async function holdLoadingPaint(canvas: Locator) {
  await canvas.evaluate(() => (globalThis as unknown as { loadingPaintGate: LoadingPaintGate }).loadingPaintGate.arm());
}

async function releaseLoadingPaint(canvas: Locator) {
  await canvas.evaluate(() => (globalThis as unknown as { loadingPaintGate: LoadingPaintGate }).loadingPaintGate.release());
}

for (const mode of ["Play", "Preview Build"] as const) {
  test(`${mode} retains a moving global SceneLayer across world loading, visible resize and modal dismissal`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    // Install in both the editor document and future Preview iframe before
    // their runtime canvas exists, so initial modal dismissal is observable.
    await page.addInitScript(() => {
      const nativePost = Worker.prototype.postMessage;
      let armed = false;
      let pending: (() => void) | undefined;
      const gate: LoadingPaintGate = {
        get held() { return pending !== undefined; },
        workCommands: [],
        arm: () => { gate.workCommands.length = 0; armed = true; },
        release: () => { armed = false; const send = pending; pending = undefined; send?.(); },
      };
      (globalThis as unknown as { loadingPaintGate: LoadingPaintGate }).loadingPaintGate = gate;
      Worker.prototype.postMessage = function(this: Worker, ...args: Parameters<Worker["postMessage"]>) {
        const message = args[0] as { channel?: unknown; payload?: { type?: unknown } };
        if (armed && message?.channel === "control" && message.payload?.type === "sceneLoadingPainted") {
          armed = false;
          const observe = (event: MessageEvent<{ channel?: unknown; payload?: { type?: unknown } }>) => {
            if (event.data?.channel === "command" && typeof event.data.payload?.type === "string") gate.workCommands.push(event.data.payload.type);
          };
          this.addEventListener("message", observe);
          pending = () => { this.removeEventListener("message", observe); Reflect.apply(nativePost, this, args); };
          return;
        }
        Reflect.apply(nativePost, this, args);
      };
      const copy = document.createElement("canvas");
      copy.width = 96; copy.height = 64;
      const context = copy.getContext("2d", { willReadFrequently: true })!;
      let frame = 0, released = false, sawPresenting = false;
      const samples: Array<{ phase: string; lit: number }> = [];
      const state = { samples, stop: () => cancelAnimationFrame(frame), dialogSeen: false };
      (globalThis as unknown as { startupCanvasContinuity: typeof state }).startupCanvasContinuity = state;
      const inspect = () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="play-canvas"], [data-testid="player-canvas"]');
        if (canvas) {
          const root = document.querySelector<HTMLElement>('[data-testid="player-root"]');
          const dialog = document.querySelector('[data-testid="scene-loading-dialog"]');
          if (dialog) state.dialogSeen = true;
          const shown = root
            ? root.dataset.sceneLoading === "true"
            : Boolean(dialog && !dialog.closest("[data-closed]") && (!(dialog instanceof HTMLDialogElement) || dialog.open));
          const phase = shown
            ? root
              ? root.dataset.sceneLoadPhase ?? ""
              : dialog!.querySelector('[data-slot="progress-label"], [role="status"]')?.textContent ?? ""
            : "";
          if (phase === "Presenting First Frame") sawPresenting = true;
          if (sawPresenting && !shown) released = true;
          if (released) {
            context.clearRect(0, 0, 96, 64);
            context.drawImage(canvas, 0, 0, 96, 64);
            const pixels = context.getImageData(0, 0, 96, 64).data;
            let lit = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 180) lit++;
            samples.push({ phase, lit });
          }
        }
        if (samples.length < 1000) frame = requestAnimationFrame(inspect);
      };
      frame = requestAnimationFrame(inspect);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) && /GPUValidation|validation error|InvalidCommandBuffer|OUT_OF_MEMORY|CONTEXT_LOST|invalid uniform|destroyed texture|Scene loading failed|Unable to compile|RGBD texture decode failed/i.test(message.text())) errors.push(message.text());
    });
    await openMinimalTestProject(page, await filesForContinuity());
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    if (mode === "Play") await clickPlayAndWaitForOverlay(page);
    else {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    }
    const canvas = mode === "Play" ? page.getByTestId("play-canvas") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas");
    const dialog = mode === "Play" ? page.getByTestId("scene-loading-dialog") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("scene-loading-dialog");
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await observeCanvas(canvas);
    try {
      await expect.poll(async () => (await samples(canvas)).some((sample) => sample.hud > 5), { timeout: 30_000 }).toBe(true);
    } catch (error) {
      await testInfo.attach("startup-hud-samples.json", { body: JSON.stringify(await samples(canvas)), contentType: "application/json" });
      await testInfo.attach("startup-hud-visuals.json", { body: JSON.stringify(await canvas.evaluate(() =>
        ((globalThis as unknown as { __babylonslatePlayTest?: { visuals?: () => unknown[] }; __babylonslatePlayerTest?: { visuals?: () => unknown[] } })
          .__babylonslatePlayTest ?? (globalThis as unknown as { __babylonslatePlayerTest?: { visuals?: () => unknown[] } }).__babylonslatePlayerTest)
          ?.visuals?.())), contentType: "application/json" });
      await canvas.screenshot({ path: testInfo.outputPath("startup-hud-timeout.png") });
      throw error;
    }
    await expect.poll(() => canvas.evaluate(() =>
      (globalThis as unknown as { startupCanvasContinuity: { samples: unknown[] } }).startupCanvasContinuity.samples.length)).toBeGreaterThan(2);
    const startup = await canvas.evaluate(() => {
      const state = (globalThis as unknown as { startupCanvasContinuity: { samples: Array<{ phase: string; lit: number }>; dialogSeen: boolean; stop: () => void } }).startupCanvasContinuity;
      state.stop(); return { samples: state.samples, dialogSeen: state.dialogSeen };
    });
    expect(Math.min(...startup.samples.map((sample) => sample.lit))).toBeGreaterThan(5);
    if (mode === "Preview Build") expect(startup.dialogSeen).toBe(false);
    expect(await canvas.evaluate((node: HTMLCanvasElement) => Boolean(node.getContext("2d")))).toBe(true);
    await testInfo.attach("initial-modal-dismissal.json", { body: JSON.stringify(startup), contentType: "application/json" });
    if (mode === "Play") await page.getByTestId("play-console-open").click();
    else await page.getByRole("button", { name: "Console", exact: true }).click();
    for (let reload = 0; reload < 2; reload++) {
      await observeCanvas(canvas);
      await holdLoadingPaint(canvas);
      try {
        await page.getByTestId("debug-console-input").fill(`changescene ${WORLD}`);
        await page.getByTestId("debug-console-submit").click();
        // The actual runtime waits for this host ACK before teardown. Retained
        // owners must move on the visible canvas throughout that waiting period.
        await expect.poll(async () => {
          const held = (await samples(canvas)).filter((sample) => sample.paintHeld);
          const latest = held.at(-1);
          if (!latest) return 0;
          const sameSize = held.filter((sample) => sample.width === latest.width && sample.height === latest.height);
          return new Set(sameSize.map((sample) => sample.center)).size;
        }).toBeGreaterThan(1);
        const work = await canvas.evaluate(() => (globalThis as unknown as { loadingPaintGate: LoadingPaintGate }).loadingPaintGate.workCommands);
        expect(work.filter((type) => ["despawn", "activeScene", "assignMesh", "sceneRealized"].includes(type))).toEqual([]);
      } finally {
        try {
          await testInfo.attach(`held-loading-${reload}.json`, { body: JSON.stringify(await samples(canvas)), contentType: "application/json" });
          await testInfo.attach(`held-runtime-commands-${reload}.json`, { body: JSON.stringify(await canvas.evaluate(() =>
            (globalThis as unknown as { loadingPaintGate: LoadingPaintGate }).loadingPaintGate.workCommands)), contentType: "application/json" });
        }
        finally { await releaseLoadingPaint(canvas); }
      }
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect.poll(async () => (await samples(canvas)).filter((sample) => sample.phase === "").length).toBeGreaterThan(2);
      const result = await samples(canvas);
      await testInfo.attach(`continuity-${reload}.json`, { body: JSON.stringify(result), contentType: "application/json" });
      expect(result.some((sample) => sample.phase === "Presenting First Frame")).toBe(true);
      expect(Math.min(...result.map((sample) => sample.lit))).toBeGreaterThan(5);
      expect(Math.min(...result.map((sample) => sample.hud))).toBeGreaterThan(5);
      if (mode === "Preview Build")
        expect(await canvas.evaluate(() => (globalThis as unknown as { continuity: Observation }).continuity.dialogSeen)).toBe(false);
      const loading = result.filter((sample) => sample.phase && sample.phase !== "Presenting First Frame");
      expect(new Set(loading.map((sample) => sample.hudX)).size).toBeGreaterThan(1);
      expect(new Set(loading.map((sample) => sample.center)).size).toBeGreaterThan(1);
      expect(new Set(result.map((sample) => `${sample.width}x${sample.height}`)).size).toBeGreaterThan(1);
    }
    await canvas.evaluate(() => (globalThis as unknown as { continuity: Observation }).continuity.stop());
    await canvas.screenshot({ path: testInfo.outputPath("retained-global-layer.png") });
    if (mode === "Preview Build") {
      await holdLoadingPaint(canvas);
      try {
        await page.getByTestId("debug-console-input").fill(`changescene ${WORLD}`);
        await page.getByTestId("debug-console-submit").click();
        await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
        await expect.poll(() => canvas.evaluate(() => (globalThis as unknown as { loadingPaintGate: LoadingPaintGate }).loadingPaintGate.held)).toBe(true);
        // The player owns no Stop control; the host overlay close is the only
        // stop path and destroys the iframe mid-load.
        await page.getByTestId("preview-build-close").click();
        await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
      } finally { await releaseLoadingPaint(canvas).catch(() => {}); }
    } else {
      await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
      await page.getByTestId("play-overlay-close").click();
    }
    await waitForSceneViewportReady(page);
    expect(errors).toEqual([]);
  });
}
