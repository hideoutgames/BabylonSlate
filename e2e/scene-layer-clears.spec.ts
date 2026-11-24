import { expect, test, type Page } from "@playwright/test";
import {
  createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, MAIN_CLASS_FILE, MAIN_SCENE_FILE,
  type SerializedActor, type SerializedComponent,
} from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";
import { SOFTWARE_GL_ARGS } from "./software-gl";
import { GAIN_GUID, PANEL_COMPONENT_ID, PANEL_STEPS_GRAPH } from "./scene-layer-post-process-panel-graph";

if (process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

const CLASS_GUID = "00000000-0000-4000-8000-000000000002";
const BLUE_GUID = "00000000-0000-4000-8000-000000000071";
const GREEN_GUID = "00000000-0000-4000-8000-000000000072";
const RED_GUID = "00000000-0000-4000-8000-000000000073";
const LAYERS = ["PlainA", "PlainB", "PlainC", "BoxesFront", "BoxesBack", "Occlusion", "Paneled"] as const;
const layerGuid = (index: number) => `00000000-0000-4000-8000-0000000000${(80 + index).toString()}`;

type Diagnostics = { layerFrame?: { depthClears: number; targetSwitches: number; backbuffer: { clears: number; depthClears: number; elided: number } } };
type PlayHost = { __hapticPlayTest?: { rendering(): Diagnostics | null } };

/** The SHA-256 of the Play canvas's pixels, as the page copies them. */
const frameSha = (page: Page) => page.getByTestId("play-canvas").evaluate(async (canvas: HTMLCanvasElement) => {
  const copy = document.createElement("canvas");
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(canvas, 0, 0);
  const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pixels));
  return `${copy.width}x${copy.height}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
});

/** The frame once two reads in a row agree (and differ from `unlike`, when given). */
async function settled(page: Page, unlike?: string): Promise<string> {
  let previous = "";
  let current = "";
  await expect.poll(async () => {
    current = await frameSha(page);
    const same = current === previous && current !== unlike;
    previous = current;
    return same;
  }, { timeout: 60_000, intervals: [300] }).toBe(true);
  return current;
}

/** The RGB of the Play canvas at a point of its layer units (the 32 × 18 canvas, x right, y up, fitted to the screen). */
const colourAt = (page: Page, x: number, y: number) => page.getByTestId("play-canvas").evaluate((canvas: HTMLCanvasElement, [u, v]) => {
  const copy = document.createElement("canvas");
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(canvas, 0, 0);
  const pixel = context.getImageData(Math.floor((u! + 16) / 32 * copy.width), Math.floor((9 - v!) / 18 * copy.height), 1, 1).data;
  return [pixel[0]!, pixel[1]!, pixel[2]!];
}, [x, y] as const);
const isColour = (rgb: number[], channel: 0 | 1 | 2) => rgb[channel]! > 200 && rgb.every((value, index) => index === channel || value < 60);

const layerWork = (page: Page) => page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.rendering()?.layerFrame ?? null);

/**
 * Scene Layers leave out the depth-stencil clears the backbuffer already holds (the world output pass's clear takes the
 * first layer's): `layerdebug skipclears on` and `off` must draw the same bytes. Three plain layers of 2D quads, two
 * layers of turned 3D boxes overlapping each other on screen (the back layer's boxes behind the front layer's in depth),
 * a layer of opaque boxes that overlap in pairs, the nearer one listed first in one pair and second in the other, a layer
 * with a Post Processing Panel, then the shared Scene Layer stack with a pass. The boxes' Opaque Materials draw with
 * depth writes, so the nearer box wins whatever the order, and the back layer's clear must run: its boxes, behind the
 * front layer's in depth, still draw over them. The 2D quads blend and write no depth.
 */
test("leaving out the Scene Layers' already-cleared depth-stencil clears changes no pixel", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The WebGL2 contexts the page makes, so a step can replace the end-of-frame invalidate.
  await page.addInitScript(() => {
    const contexts: WebGL2RenderingContext[] = [];
    (globalThis as unknown as { __layerClearsContexts: WebGL2RenderingContext[] }).__layerClearsContexts = contexts;
    const getContext = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, type: string, options?: unknown) => unknown;
    (HTMLCanvasElement.prototype as unknown as { getContext: typeof getContext }).getContext = function (type, options) {
      const context = getContext.call(this, type, options);
      if (type === "webgl2" && context && !contexts.includes(context as WebGL2RenderingContext)) contexts.push(context as WebGL2RenderingContext);
      return context;
    };
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /webgl|shader|glsl|gl_invalid|program|compile/i.test(message.text())) errors.push(message.text());
  });
  const files = await minimalProjectFiles();
  const versions = createDefaultMigrationRegistry();
  const material = async (guid: string, name: string, color: [number, number, number]) => {
    const document = createDefaultMaterialDocument(name);
    document.shadingModel = "unlit";
    document.nodes[0]!.properties.value = color;
    files.set(`assets/${name}.material.hasset`, await encodeAssetDocument({
      guid, type: "Material", name, version: versions.currentVersion("Material"), payload: document as unknown as Record<string, unknown>,
    }));
  };
  await material(BLUE_GUID, "Blue", [0, 0, 1]);
  await material(GREEN_GUID, "Green", [0, 1, 0]);
  await material(RED_GUID, "Red", [1, 0, 0]);
  // A post-process pass that scales colour and alpha by Gain (0.5).
  const gain = createDefaultMaterialDocument("Gain", "postProcess");
  gain.nodes.push(
    { id: "gain", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Gain", value: [0.5] } },
    { id: "multiply", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
  );
  gain.edges = gain.edges.filter((entry) => entry.id !== "e-scene-output");
  gain.edges.push(
    { id: "color", sourceNodeId: "sceneColor", sourcePinId: "color", targetNodeId: "multiply", targetPinId: "a" },
    { id: "gain", sourceNodeId: "gain", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "b" },
    { id: "out", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
  );
  files.set("assets/Gain.material.hasset", await encodeAssetDocument({
    guid: GAIN_GUID, type: "Material", name: "Gain", version: versions.currentVersion("Material"), payload: gain as unknown as Record<string, unknown>,
  }));
  const panel: SerializedComponent =
    { id: PANEL_COMPONENT_ID, classId: "2DPostProcessingPanelComponent", properties: { enabled: true, materialGuid: null } };
  files.set(MAIN_CLASS_FILE, await encodeAssetDocument({
    guid: CLASS_GUID, type: "Class", name: "Main", version: versions.currentVersion("Class"),
    payload: { ...PANEL_STEPS_GRAPH, components: [panel] } as unknown as Record<string, unknown>,
  }, { parentClass: "SceneLayerActor", dependencies: [GAIN_GUID] }));

  const turn = (x: number, y: number, z: number): [number, number, number, number] => {
    // Euler degrees to a quaternion (X, then Y, then Z), as an actor's 3D rotation.
    const [hx, hy, hz] = [x, y, z].map((degrees) => degrees * Math.PI / 360) as [number, number, number];
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(hx), Math.sin(hx), Math.cos(hy), Math.sin(hy), Math.cos(hz), Math.sin(hz)];
    return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
  };
  const quad = (id: string, materialGuid: string, position: [number, number], scale: [number, number]): SerializedActor =>
    createActor(id, id, { classId: "SceneLayerActor", transform: { position: [position[0], position[1], 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ id: `${id}-quad`, classId: "2DMaterialComponent", properties: { materialGuid }, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [scale[0], scale[1], 1] } }] });
  const box = (id: string, materialGuid: string, position: [number, number, number], rotation: [number, number, number],
    scale: [number, number, number] = [2, 2, 2]): SerializedActor => {
    const mesh = createMeshComponent(`${id}-mesh`, "box");
    mesh.properties.materialGuid = materialGuid;
    return createActor(id, id, { classId: "SceneLayerActor", transform: { position, rotation: turn(...rotation), scale }, components: [mesh] });
  };
  const contents: Record<(typeof LAYERS)[number], SerializedActor[]> = {
    PlainA: [quad("a1", BLUE_GUID, [-10, 4], [6, 4]), quad("a2", GREEN_GUID, [-6, 2], [4, 4])],
    PlainB: [quad("b1", RED_GUID, [-8, 3], [5, 3]), quad("b2", BLUE_GUID, [-12, -2], [3, 6])],
    PlainC: [quad("c1", GREEN_GUID, [-9, 1], [8, 2])],
    // Turned boxes that cut into each other within the layer, and over the back layer's on screen.
    BoxesFront: [box("f1", BLUE_GUID, [6, 2, 0], [30, 40, 10]), box("f2", GREEN_GUID, [7.5, 2.5, 0.5], [-20, 15, 35])],
    // Behind the front layer's boxes in depth (the camera looks along +Z): only the layer's own depth clear shows them.
    BoxesBack: [box("k1", RED_GUID, [6.5, 2, 4], [10, 60, 0]), box("k2", RED_GUID, [8, 1, 3], [45, 0, 20])],
    // Two thin slabs 3 units across through one centre: one facing the camera, one turned 45° about Y, so it is nearer
    // on one side of the centre and farther on the other. Only depth can show each slab where it is nearer: sorted by
    // distance alone (they share a centre), one slab would cover the other on both sides.
    Occlusion: [
      box("facing", GREEN_GUID, [-2, 6, 1.5], [0, 0, 0], [2, 2, 0.1]),
      box("turned", BLUE_GUID, [-2, 6, 1.5], [0, 45, 0], [2, 2, 0.1]),
    ],
    Paneled: [
      createActor("frame", "Frame", { classId: "main", transform: { position: [0, -5, 0], rotation: [0, 0, 0, 1], scale: [8, 6, 1] }, components: [panel] }),
      createActor("icon", "Icon", { classId: "SceneLayerActor", parentId: "frame", transform: { position: [0.4, 0, 0], rotation: [0, 0, 0, 1], scale: [0.5, 0.5, 1] },
        components: [{ id: "icon-quad", classId: "2DMaterialComponent", properties: { materialGuid: BLUE_GUID },
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] }),
      // A switched-off panel naming Gain, so Play loads the Material the script gives the frame.
      createActor("spare", "Spare", { classId: "SceneLayerActor", transform: { position: [12, 6, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [{ id: "spare-panel", classId: "2DPostProcessingPanelComponent", properties: { enabled: false, materialGuid: GAIN_GUID } }] }),
    ],
  };
  for (const [index, name] of LAYERS.entries()) {
    const document = createDefaultSceneLayer();
    document.settings.canvas = { ...document.settings.canvas, sizeMode: "custom", customSizePx: { width: 3200, height: 1800 } };
    document.actors = contents[name];
    files.set(`assets/${name}.scenelayer.hasset`, await encodeAssetDocument({
      guid: layerGuid(index), type: "SceneLayer", name, version: versions.currentVersion("SceneLayer"), payload: document as unknown as Record<string, unknown>,
    }, { dependencies: name === "Paneled" ? [CLASS_GUID, BLUE_GUID, GAIN_GUID] : [BLUE_GUID, GREEN_GUID, RED_GUID] }));
  }
  const scene = createDefaultScene();
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.defaultCameraActorId);
  scene.settings.environmentColor = [0.25, 0.25, 0.25];
  scene.settings.sceneLayers = LAYERS.map((_, index) => ({ assetGuid: layerGuid(index), zOrder: index + 1, enabled: true }));
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", version: versions.currentVersion("Scene"),
    payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: LAYERS.map((_, index) => layerGuid(index)) }));

  await openMinimalTestProject(page, files);
  await showOverlayButtons(page, ["console"]);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText("Panel ready", { timeout: 60_000 });
  const canvas = page.getByTestId("play-canvas");
  await page.getByTestId("play-console-open").click();
  const command = async (line: string) => {
    await page.getByTestId("debug-console-input").fill(line);
    await page.getByTestId("debug-console-submit").click();
    await expect(page.getByTestId("debug-console-input")).toHaveValue("");
  };
  const closeConsole = () => page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();

  const results: Record<string, unknown> = {};
  /** The frame with already-cleared depth-stencil clears left out (the default) and with every clear: the same bytes. */
  const compare = async (stage: string) => {
    const skipped = await settled(page);
    const skippedWork = await layerWork(page);
    await command("layerdebug skipclears off");
    const every = await settled(page);
    const everyWork = await layerWork(page);
    await command("layerdebug skipclears on");
    expect(await settled(page), `${stage}: back on`).toBe(skipped);
    results[stage] = { skipped, every, skippedWork, everyWork };
    expect(every, stage).toBe(skipped);
    return { skipped, skippedWork, everyWork };
  };

  // Three plain layers, the two box layers and the panel layer whose panel has no Material yet.
  const plain = await compare("plain and 3D layers");
  // Layers straight over the world: the world's output pass takes the first layer's clear; a layer pass with every
  // clear has one more depth-stencil clear on the backbuffer than with the cleared ones left out.
  expect(plain.skippedWork?.backbuffer.elided).toBeGreaterThanOrEqual(1);
  expect(plain.everyWork?.backbuffer.elided).toBe(0);
  // Each clear left out is a call fewer; the world's colour clear took depth and stencil too.
  const { skippedWork, everyWork } = plain;
  expect(skippedWork!.backbuffer.clears).toBe(everyWork!.backbuffer.clears - skippedWork!.backbuffer.elided);
  expect(skippedWork!.backbuffer.depthClears).toBe(everyWork!.backbuffer.depthClears - skippedWork!.backbuffer.elided + 1);
  await canvas.screenshot({ path: testInfo.outputPath("scene-layer-clears-plain.png") });
  // The crossing slabs: the turned one shows on the side where it is nearer, the facing one on the other.
  const sides = [await colourAt(page, -2.6, 6), await colourAt(page, -1.4, 6)];
  const slab = (rgb: number[]) => isColour(rgb, 2) ? "turned" : isColour(rgb, 1) ? "facing" : `other ${rgb.join(",")}`;
  expect(sides.map(slab).sort(), "each slab where it is nearer").toEqual(["facing", "turned"]);
  // The back layer draws over the front one, its boxes behind them in depth: its own depth clear ran.
  expect(isColour(await colourAt(page, 6.25, 2), 0), "back layer over the front layer").toBe(true);
  // The front and occluding layers write depth, so the clears after them run: more than the world's merged clear.
  expect(skippedWork!.backbuffer.depthClears).toBeGreaterThanOrEqual(3);
  expect(skippedWork!.backbuffer.elided).toBeLessThan(everyWork!.backbuffer.depthClears);
  // Play invalidates the backbuffer's depth and stencil after each frame: no later frame reads them before its own clear.
  // From here on depth 0 and stencil 0xFF are written in place of the invalidate, as a tile-based GPU may leave them:
  // no pixel changes, here or in the stages below (the shared stack's composite over the world included).
  const poisoned = await page.evaluate(() => {
    const gl = (globalThis as unknown as { __layerClearsContexts: WebGL2RenderingContext[] }).__layerClearsContexts
      .filter((context) => !context.isContextLost()).sort((a, b) => b.drawingBufferWidth - a.drawingBufferWidth)[0]!;
    const counts = { poisoned: 0 };
    const original = gl.invalidateFramebuffer;
    gl.invalidateFramebuffer = function (target: GLenum, attachments: GLenum[]) {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null || !attachments.includes(gl.DEPTH)) return original.call(gl, target, attachments);
      counts.poisoned += 1;
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
      const stencilMask = gl.getParameter(gl.STENCIL_WRITEMASK) as number;
      const depthClear = gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number;
      const stencilClear = gl.getParameter(gl.STENCIL_CLEAR_VALUE) as number;
      gl.disable(gl.SCISSOR_TEST); gl.depthMask(true); gl.stencilMask(0xff); gl.clearDepth(0); gl.clearStencil(0xff);
      gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      gl.depthMask(depthMask); gl.stencilMask(stencilMask); gl.clearDepth(depthClear); gl.clearStencil(stencilClear);
    };
    (globalThis as unknown as { __poisonCounts: typeof counts }).__poisonCounts = counts;
    return counts.poisoned;
  });
  expect(poisoned).toBe(0);
  expect(await settled(page), "depth and stencil poisoned after each frame").toBe(plain.skipped);
  const poisonCount = () => page.evaluate(() => (globalThis as unknown as { __poisonCounts: { poisoned: number } }).__poisonCounts.poisoned);
  expect(await poisonCount()).toBeGreaterThan(1);

  const step = async (text: string) => {
    await closeConsole();
    await canvas.focus();
    await page.keyboard.press("KeyN");
    await expect(page.getByTestId("print-overlay")).toContainText(text, { timeout: 30_000 });
    await page.getByTestId("play-console-open").click();
  };
  // A Post Processing Panel with the Gain pass: its content draws into its own target, its result into the layer.
  await step("Material set");
  const panelStage = await compare("Post Processing Panel");
  expect(panelStage.skipped).not.toBe(plain.skipped);
  await step("Gain written");
  // The shared Scene Layer stack with the pass: every layer draws into its target, so nothing is left out.
  await step("Pass registered");
  const poisonedBeforeStack = await poisonCount();
  const stacked = await compare("shared stack with a pass");
  expect(stacked.skippedWork?.backbuffer.elided).toBe(0);
  // The stack's frames were poisoned too.
  expect(await poisonCount()).toBeGreaterThan(poisonedBeforeStack);

  await testInfo.attach("scene-layer-clears", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  console.log(`scene layer clears: ${JSON.stringify(results)}`);
  await closeConsole();
  await page.getByTestId("play-overlay-close").click();
  expect(errors).toEqual([]);
});
