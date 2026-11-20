import { expect, test, type Page } from "@playwright/test";
import {
  createActor, createDefaultScene, createDefaultSceneLayer, MAIN_CLASS_FILE, MAIN_SCENE_FILE,
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

const PLAIN_SCENE_GUID = "00000000-0000-4000-8000-000000000001";
const CLASS_GUID = "00000000-0000-4000-8000-000000000002";
const PANEL_SCENE_GUID = "00000000-0000-4000-8000-000000000061";
const PLAIN_LAYER_GUID = "00000000-0000-4000-8000-000000000062";
const PANEL_LAYER_GUID = "00000000-0000-4000-8000-000000000063";
const BLUE_GUID = "00000000-0000-4000-8000-000000000064";
const GREEN_GUID = "00000000-0000-4000-8000-000000000065";

type FrameHost = { __panelFrames: Record<string, ImageData> };

/** Copies the Play canvas into `name` and returns a hash of its bytes. */
const capture = (page: Page, name: string) => page.getByTestId("play-canvas").evaluate((canvas: HTMLCanvasElement, key) => {
  const copy = document.createElement("canvas");
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(canvas, 0, 0);
  const image = context.getImageData(0, 0, copy.width, copy.height);
  const host = globalThis as unknown as FrameHost;
  (host.__panelFrames ??= {})[key] = image;
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
  const image = (globalThis as unknown as FrameHost).__panelFrames[key as string]!;
  const left = Math.floor((x as number) * image.width) - 3, top = Math.floor((y as number) * image.height) - 3;
  const rgb = [0, 0, 0];
  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 6; column += 1) {
    const offset = ((top + row) * image.width + left + column) * 4;
    for (let channel = 0; channel < 3; channel += 1) rgb[channel]! += image.data[offset + channel]! / 36;
  }
  return rgb;
}, [name, u, v] as const);

/**
 * How many pixels `frame` holds differently from `reference`, among the world's pixels (where `plain` equals the
 * world-only frame `world`) or, with `rightOf`, among every pixel right of that fraction of the width.
 */
const changedPixels = (page: Page, frame: string, reference: string, region: { world: [string, string] } | { rightOf: number }) =>
  page.evaluate(([test, against, area]) => {
    const frames = (globalThis as unknown as FrameHost).__panelFrames;
    const a = frames[test as string]!, b = frames[against as string]!;
    const scope = area as { world?: [string, string]; rightOf?: number };
    const plain = scope.world ? frames[scope.world[0]]!.data : null, world = scope.world ? frames[scope.world[1]]!.data : null;
    let counted = 0, changed = 0;
    for (let index = 0; index < a.data.length; index += 4) {
      if (plain && world) {
        let same = true;
        for (let channel = 0; channel < 4; channel += 1) if (plain[index + channel] !== world[index + channel]) same = false;
        if (!same) continue;
      } else if (((index / 4) % a.width) / a.width <= (scope.rightOf ?? 0)) continue;
      counted += 1;
      for (let channel = 0; channel < 4; channel += 1) if (a.data[index + channel] !== b.data[index + channel]) { changed += 1; break; }
    }
    return { counted, changed };
  }, [frame, reference, region] as const);

// Layer units: a Custom 32 × 18 canvas fitted to the screen, so x -16..16 spans the width of any screen at least
// 16:9 wide. The panel covers x -8..0 and y -3..3 (width fractions 0.25..0.5). Its child, a blue quad, covers
// x -2.8..1.2: inside the panel at INSIDE, past its right edge at PAST_EDGE, where the panel cuts it off. A green
// quad beside it, under no panel, covers x 2..6 (SIDE). Everything right of RIGHT is outside the panel and its child.
const INSIDE = 0.45, PAST_EDGE = 0.52, SIDE = 0.62, RIGHT = 0.545, MIDDLE = 0.5;

test("A Post Processing Panel without a Material draws as a plain parent; with one it grades only its clipped rectangle, under the shared stack", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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

  const quad = (id: string, materialGuid: string, scale: [number, number]): SerializedComponent =>
    ({ id, classId: "2DMaterialComponent", properties: { materialGuid }, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [scale[0], scale[1], 1] } });
  const placed = (position: [number, number], scale: [number, number]) =>
    ({ position: [position[0], position[1], 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [scale[0], scale[1], 1] as [number, number, number] });
  // The panel actor's Class: a Post Processing Panel without a Material and the steps graph.
  files.set(MAIN_CLASS_FILE, await encodeAssetDocument({
    guid: CLASS_GUID, type: "Class", name: "Main", version: versions.currentVersion("Class"),
    payload: { ...PANEL_STEPS_GRAPH, components: [{ id: PANEL_COMPONENT_ID, classId: "2DPostProcessingPanelComponent", properties: { enabled: true, materialGuid: null } }] } as unknown as Record<string, unknown>,
  }, { parentClass: "SceneLayerActor", dependencies: [GAIN_GUID] }));
  /** The same actors in both layers; only the frame differs: a plain parent, or the panel Class. */
  const actors = (frameClass: string): SerializedActor[] => [
    // Scale 8 × 6 is the panel's size; the child halves it back.
    createActor("frame", "Frame", { classId: frameClass, transform: placed([-4, 0], [8, 6]) }),
    createActor("icon", "Icon", { classId: "SceneLayerActor", parentId: "frame", transform: placed([0.4, 0], [0.5, 0.5]), components: [quad("blue", BLUE_GUID, [1, 1])] }),
    createActor("side", "Side", { classId: "SceneLayerActor", transform: placed([4, 0], [1, 1]), components: [quad("green", GREEN_GUID, [4, 3])] }),
  ];
  const layer = async (guid: string, name: string, frameClass: string, dependencies: string[]) => {
    const document = createDefaultSceneLayer();
    document.settings.canvas = { ...document.settings.canvas, sizeMode: "custom", customSizePx: { width: 3200, height: 1800 } };
    document.actors = actors(frameClass);
    files.set(`assets/${name}.scenelayer.hasset`, await encodeAssetDocument({
      guid, type: "SceneLayer", name, version: versions.currentVersion("SceneLayer"), payload: document as unknown as Record<string, unknown>,
    }, { dependencies }));
  };
  await layer(PLAIN_LAYER_GUID, "Plain", "SceneLayerActor", [BLUE_GUID, GREEN_GUID]);
  await layer(PANEL_LAYER_GUID, "Paneled", "main", [CLASS_GUID, BLUE_GUID, GREEN_GUID, GAIN_GUID]);
  const scene = async (guid: string, file: string, name: string, layerGuid: string) => {
    const document = createDefaultScene();
    document.actors = document.actors.filter((actor) => actor.id === document.settings.defaultCameraActorId);
    // A grey world, so a blend that darkens or tints it shows.
    document.settings.environmentColor = [0.25, 0.25, 0.25];
    document.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 1, enabled: true }];
    files.set(file, await encodeAssetDocument({
      guid, type: "Scene", name, version: versions.currentVersion("Scene"), payload: document as unknown as Record<string, unknown>,
    }, { dependencies: [layerGuid] }));
  };
  await scene(PLAIN_SCENE_GUID, MAIN_SCENE_FILE, "Main", PLAIN_LAYER_GUID);
  await scene(PANEL_SCENE_GUID, "assets/Paneled.scene.hasset", "Paneled", PANEL_LAYER_GUID);

  await openMinimalTestProject(page, files);
  await showOverlayButtons(page, ["console"]);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  const canvas = page.getByTestId("play-canvas");
  const isBlue = (rgb: number[]) => rgb[2]! > 200 && rgb[0]! < 40 && rgb[1]! < 40;
  const isGreen = (rgb: number[]) => rgb[1]! > 200 && rgb[0]! < 40 && rgb[2]! < 40;
  await expect.poll(async () => {
    await capture(page, "plain");
    return isBlue(await sample(page, "plain", INSIDE, MIDDLE)) && isBlue(await sample(page, "plain", PAST_EDGE, MIDDLE)) &&
      isGreen(await sample(page, "plain", SIDE, MIDDLE));
  }, { timeout: 60_000 }).toBe(true);
  // The plain parent's layer.
  const plain = await settledFrame(page, "plain");

  await page.getByTestId("play-console-open").click();
  const command = async (line: string) => {
    await page.getByTestId("debug-console-input").fill(line);
    await page.getByTestId("debug-console-submit").click();
    await expect(page.getByTestId("debug-console-input")).toHaveValue("");
  };
  // The world alone, for the pixels outside every layer.
  await command("scenelayers off");
  await settledFrame(page, "world", plain);
  await command("scenelayers on");
  expect(await settledFrame(page, "plain-again", await capture(page, "world"))).toBe(plain);

  // (a) The same layer with the frame a Post Processing Panel without a Material: byte for byte the plain parent's.
  await command(`changescene ${PANEL_SCENE_GUID}`);
  await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
  // The panel layer's actor began play: the new Scene and its layer are up.
  await expect(page.getByTestId("print-overlay")).toContainText("Panel ready", { timeout: 60_000 });
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 60_000 });
  await expect.poll(() => capture(page, "panel-plain"), { timeout: 60_000, intervals: [250] }).toBe(plain);
  expect(await settledFrame(page, "panel-plain")).toBe(plain);

  const step = async (text: string) => {
    await canvas.focus();
    await expect(canvas).toBeFocused();
    await page.keyboard.press("KeyN");
    await expect(page.getByTestId("print-overlay")).toContainText(text, { timeout: 30_000 });
  };
  const worldUnchanged = async (frame: string) => expect((await changedPixels(page, frame, "world", { world: ["plain", "world"] })).changed).toBe(0);
  const rightUnchanged = async (frame: string) => {
    const right = await changedPixels(page, frame, "plain", { rightOf: RIGHT });
    expect(right.counted).toBeGreaterThan(0);
    expect(right.changed).toBe(0);
  };
  const near = (a: number[], b: number[]) => a.every((value, channel) => Math.abs(value - b[channel]!) <= 2);

  // (b) The Material at Gain 0.5: the panel's content is graded and cut to its rectangle; nothing else changes.
  await step("Material set");
  const graded = await settledFrame(page, "graded", plain);
  const plainInside = await sample(page, "plain", INSIDE, MIDDLE);
  const gradedInside = await sample(page, "graded", INSIDE, MIDDLE);
  expect(plainInside[2]! - gradedInside[2]!).toBeGreaterThan(40);
  expect(gradedInside[2]!).toBeGreaterThan(gradedInside[1]! + 40);
  // Past the panel's edge the child is gone: the world shows there.
  expect(near(await sample(page, "graded", PAST_EDGE, MIDDLE), await sample(page, "world", PAST_EDGE, MIDDLE))).toBe(true);
  await worldUnchanged("graded");
  await rightUnchanged("graded");

  // (c) A live parameter write through the panel's Material Object: Gain 1 draws the content at full strength.
  await step("Gain written");
  const written = await settledFrame(page, "written", graded);
  const writtenInside = await sample(page, "written", INSIDE, MIDDLE);
  expect(writtenInside[2]! - gradedInside[2]!).toBeGreaterThan(40);
  await worldUnchanged("written");
  await rightUnchanged("written");

  // (d) The shared Scene Layer stack (the same Gain 0.5 pass) runs over the whole layer, the panel's result included.
  await step("Pass registered");
  await settledFrame(page, "stacked", written);
  const plainSide = await sample(page, "plain", SIDE, MIDDLE);
  const stackedSide = await sample(page, "stacked", SIDE, MIDDLE);
  expect(plainSide[1]! - stackedSide[1]!).toBeGreaterThan(40);
  const stackedInside = await sample(page, "stacked", INSIDE, MIDDLE);
  expect(writtenInside[2]! - stackedInside[2]!).toBeGreaterThan(40);
  await worldUnchanged("stacked");

  await canvas.screenshot({ path: testInfo.outputPath("scene-layer-post-process-panel.png") });
  await page.getByTestId("play-overlay-close").click();
  expect(errors).toEqual([]);
});
