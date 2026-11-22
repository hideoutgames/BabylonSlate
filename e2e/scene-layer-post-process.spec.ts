import { expect, test, type Page } from "@playwright/test";
import {
  createActor, createDefaultScene, createDefaultSceneLayer, MAIN_CLASS_FILE, MAIN_SCENE_FILE, PROJECT_FILE,
  type ProjectDocument, type SerializedComponent,
} from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";
import { SOFTWARE_GL_ARGS } from "./software-gl";
import { GAIN_GUID, STEPS_GRAPH } from "./scene-layer-post-process-graph";

if (process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

const SCENE_GUID = "00000000-0000-4000-8000-000000000001";
const CLASS_GUID = "00000000-0000-4000-8000-000000000002";
const BACK_LAYER_GUID = "00000000-0000-4000-8000-000000000051";
const FRONT_LAYER_GUID = "00000000-0000-4000-8000-000000000052";
const BLUE_GUID = "00000000-0000-4000-8000-000000000053";
const GREEN_GUID = "00000000-0000-4000-8000-000000000054";

type FrameHost = { __layerFrames: Record<string, ImageData> };

/** Copies the Play canvas into `name` and returns a hash of its bytes. */
const capture = (page: Page, name: string) => page.getByTestId("play-canvas").evaluate((canvas: HTMLCanvasElement, key) => {
  const copy = document.createElement("canvas");
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(canvas, 0, 0);
  const image = context.getImageData(0, 0, copy.width, copy.height);
  const host = globalThis as unknown as FrameHost;
  (host.__layerFrames ??= {})[key] = image;
  let hash = 2166136261;
  for (let index = 0; index < image.data.length; index += 1) hash = Math.imul(hash ^ image.data[index]!, 16777619);
  return `${image.width}x${image.height}:${hash >>> 0}`;
}, name);

/** Captures `name` until two reads in a row hold the same bytes and differ from `unlike` (when given). */
async function settledFrame(page: Page, name: string, unlike?: string): Promise<string> {
  let previous = "";
  let current = "";
  await expect.poll(async () => {
    current = await capture(page, name);
    const settled = current === previous && current !== unlike;
    previous = current;
    return settled;
  }, { timeout: 60_000, intervals: [250] }).toBe(true);
  return current;
}

/** The mean RGB of a 6 × 6 block of a captured frame at a fraction of its width and height. */
const sample = (page: Page, name: string, u: number, v: number) => page.evaluate(([key, x, y]) => {
  const image = (globalThis as unknown as FrameHost).__layerFrames[key as string]!;
  const left = Math.floor((x as number) * image.width) - 3, top = Math.floor((y as number) * image.height) - 3;
  const rgb = [0, 0, 0];
  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 6; column += 1) {
    const offset = ((top + row) * image.width + left + column) * 4;
    for (let channel = 0; channel < 3; channel += 1) rgb[channel]! += image.data[offset + channel]! / 36;
  }
  return rgb;
}, [name, u, v] as const);

/**
 * Pixels outside every layer: those the direct frame and the no-layer world frame agree on. Returns how many there
 * are and how many of them `frame` changed.
 */
const worldPixelChanges = (page: Page, direct: string, world: string, frame: string) => page.evaluate(([a, b, c]) => {
  const frames = (globalThis as unknown as FrameHost).__layerFrames;
  const withLayers = frames[a]!.data, worldOnly = frames[b]!.data, test = frames[c]!.data;
  let world = 0, changed = 0;
  for (let index = 0; index < worldOnly.length; index += 4) {
    let same = true;
    for (let channel = 0; channel < 4; channel += 1) if (withLayers[index + channel] !== worldOnly[index + channel]) same = false;
    if (!same) continue;
    world += 1;
    for (let channel = 0; channel < 4; channel += 1) if (test[index + channel] !== worldOnly[index + channel]) { changed += 1; break; }
  }
  return { world, changed, total: worldOnly.length / 4 };
}, [direct, world, frame] as const);

// Layer units: the canvas is a Custom 32 × 18 units fitted to the screen. Back (blue) covers x -8..0, front (green)
// x -2..6, both y -3..3: these fractions of the width lie inside the blue-only, overlapping and green-only spans for
// any screen at least 16:9 wide (a narrower one adds space above and below, leaving them in place).
const BLUE_ONLY = 0.36, OVERLAP = 0.475, GREEN_ONLY = 0.59, MIDDLE = 0.5;

test("Scene Layer post-processing draws every layer into one target its passes grade, and leaves the direct frame untouched without passes", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /webgl|shader|glsl|gl_invalid|program|compile/i.test(message.text())) errors.push(message.text());
  });
  const files = await minimalProjectFiles();
  const versions = createDefaultMigrationRegistry();
  const material = async (guid: string, name: string, color: [number, number, number]) => {
    const document = createDefaultMaterialDocument(name, "ui");
    document.nodes[0]!.properties.value = color;
    files.set(`assets/${name}.material.hasset`, await encodeAssetDocument({
      guid, type: "Material", name, version: versions.currentVersion("Material"), payload: document as unknown as Record<string, unknown>,
    }));
  };
  await material(BLUE_GUID, "Blue", [0, 0, 1]);
  await material(GREEN_GUID, "Green", [0, 1, 0]);
  // A post-process pass that scales colour and alpha by Gain (0.5): transparent pixels stay transparent.
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
  // The Project Setting holds the pass, switched off: Play starts with no enabled pass.
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!)) as ProjectDocument;
  project.settings.sceneLayerPostProcessStack = [{ id: "gain-pass", materialGuid: GAIN_GUID, enabled: false }];
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));

  const panel = (id: string, materialGuid: string, x: number): SerializedComponent =>
    ({ id, classId: "2DMaterialComponent", properties: { materialGuid }, transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [8, 6, 1] } });
  // A scene or layer actor carries its own components; its Class's are what a new instance copies.
  const backPanel = panel("blue", BLUE_GUID, -4);
  files.set(MAIN_CLASS_FILE, await encodeAssetDocument({
    guid: CLASS_GUID, type: "Class", name: "Main", version: versions.currentVersion("Class"),
    payload: { ...STEPS_GRAPH, components: [backPanel] } as unknown as Record<string, unknown>,
  }, { parentClass: "SceneLayerActor", dependencies: [BLUE_GUID, GAIN_GUID] }));
  const layer = async (guid: string, name: string, actor: ReturnType<typeof createActor>, dependencies: string[]) => {
    const document = createDefaultSceneLayer();
    document.settings.canvas = { ...document.settings.canvas, sizeMode: "custom", customSizePx: { width: 3200, height: 1800 } };
    document.actors = [actor];
    files.set(`assets/${name}.scenelayer.hasset`, await encodeAssetDocument({
      guid, type: "SceneLayer", name, version: versions.currentVersion("SceneLayer"), payload: document as unknown as Record<string, unknown>,
    }, { dependencies }));
  };
  await layer(BACK_LAYER_GUID, "Back", createActor("back", "Back", { classId: "main", components: [backPanel] }), [CLASS_GUID, BLUE_GUID]);
  await layer(FRONT_LAYER_GUID, "Front", createActor("front", "Front", { classId: "SceneLayerActor", components: [panel("green", GREEN_GUID, 2)] }), [GREEN_GUID]);
  const scene = createDefaultScene();
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.defaultCameraActorId);
  // A grey world, so a blend that darkens or tints it shows.
  scene.settings.environmentColor = [0.25, 0.25, 0.25];
  scene.settings.sceneLayers = [
    { assetGuid: FRONT_LAYER_GUID, zOrder: 2, enabled: true },
    { assetGuid: BACK_LAYER_GUID, zOrder: 1, enabled: true },
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: SCENE_GUID, type: "Scene", name: "Main", version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: [BACK_LAYER_GUID, FRONT_LAYER_GUID] }));

  await openMinimalTestProject(page, files);
  await showOverlayButtons(page, ["console"]);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  const canvas = page.getByTestId("play-canvas");
  const isBlue = (rgb: number[]) => rgb[2]! > 200 && rgb[0]! < 40 && rgb[1]! < 40;
  const isGreen = (rgb: number[]) => rgb[1]! > 200 && rgb[0]! < 40 && rgb[2]! < 40;
  await expect.poll(async () => {
    await capture(page, "direct");
    return isBlue(await sample(page, "direct", BLUE_ONLY, MIDDLE)) && isGreen(await sample(page, "direct", GREEN_ONLY, MIDDLE));
  }, { timeout: 60_000 }).toBe(true);
  // (a) No enabled pass, none ever registered: the direct path, front over back.
  const direct = await settledFrame(page, "direct");
  expect(isGreen(await sample(page, "direct", OVERLAP, MIDDLE))).toBe(true);

  // The world alone (`scenelayers off`), for the pixels outside every layer.
  await page.getByTestId("play-console-open").click();
  const command = async (line: string) => {
    await page.getByTestId("debug-console-input").fill(line);
    await page.getByTestId("debug-console-submit").click();
    await expect(page.getByTestId("debug-console-input")).toHaveValue("");
  };
  await command("scenelayers off");
  const world = await settledFrame(page, "world", direct);
  await command("scenelayers on");
  expect(await settledFrame(page, "direct-again", world)).toBe(direct);
  const coverage = await worldPixelChanges(page, "direct", "world", "direct");
  // The layers cover part of the view and leave the rest to the world.
  expect(coverage.world).toBeGreaterThan(coverage.total * 0.3);
  expect(coverage.world).toBeLessThan(coverage.total * 0.95);

  const step = async (text: string) => {
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await page.keyboard.press("KeyN");
    await expect(page.getByTestId("print-overlay")).toContainText(text, { timeout: 30_000 });
  };

  // (b) and (c): Register Scene Layer Post-Processing enables one pass over both layers.
  await step("Pass registered");
  const graded = await settledFrame(page, "graded", direct);
  const gradedBlue = await sample(page, "graded", BLUE_ONLY, MIDDLE);
  const gradedOverlap = await sample(page, "graded", OVERLAP, MIDDLE);
  const gradedGreen = await sample(page, "graded", GREEN_ONLY, MIDDLE);
  // Both layers still show, the front one over the back one where they overlap.
  expect(gradedBlue[2]!).toBeGreaterThan(gradedBlue[1]! + 40);
  expect(gradedGreen[1]!).toBeGreaterThan(gradedGreen[2]! + 40);
  expect(gradedOverlap[1]!).toBeGreaterThan(gradedOverlap[2]! + 40);
  // The pass changed the layers' pixels (half their colour and alpha) ...
  const directBlue = await sample(page, "direct", BLUE_ONLY, MIDDLE);
  const directGreen = await sample(page, "direct", GREEN_ONLY, MIDDLE);
  expect(directBlue[2]! - gradedBlue[2]!).toBeGreaterThan(40);
  expect(directGreen[1]! - gradedGreen[1]!).toBeGreaterThan(40);
  // ... and none of the world's: every pixel outside the layers is the world's own, byte for byte.
  expect((await worldPixelChanges(page, "direct", "world", "graded")).changed).toBe(0);

  // (e) A live parameter write on the registered pass changes the picture: Gain 1 draws the layers at full strength.
  await step("Gain written");
  const written = await settledFrame(page, "written", graded);
  const writtenBlue = await sample(page, "written", BLUE_ONLY, MIDDLE);
  expect(writtenBlue[2]! - gradedBlue[2]!).toBeGreaterThan(40);
  expect((await worldPixelChanges(page, "direct", "world", "written")).changed).toBe(0);
  expect(written).not.toBe(graded);

  // (d) Unregister Scene Layer Post-Processing leaves no enabled pass: the direct frame again, byte for byte.
  await step("Pass unregistered");
  await expect.poll(() => capture(page, "unregistered"), { timeout: 60_000, intervals: [250] }).toBe(direct);

  await canvas.screenshot({ path: testInfo.outputPath("scene-layer-post-process.png") });
  await page.getByTestId("play-overlay-close").click();
  expect(errors).toEqual([]);
});
