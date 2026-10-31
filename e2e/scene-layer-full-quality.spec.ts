import { expect, test, type Page } from "@playwright/test";
import {
  createActor, createDefaultScene, createDefaultSceneLayer, normalizeRenderProjectSettings, MAIN_CLASS_FILE, MAIN_SCENE_FILE, PROJECT_FILE,
  type ProjectDocument, type SerializedComponent,
} from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import type { EngineHandle } from "../packages/render/src/create-engine";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
// A high-density screen, as on an iPad: Scene Layers draw at its device pixels.
test.use({ deviceScaleFactor: 2 });

type PlayTest = {
  rendering(): ReturnType<EngineHandle["renderDiagnostics"]> | null;
  scalability(): ReturnType<EngineHandle["scalabilityStatus"]>;
};

/** The Play canvas's pixel size, its CSS box and the world's own render size. */
const sizes = (page: Page) => page.getByTestId("play-canvas").evaluate((node: HTMLCanvasElement) => {
  const host = (window as unknown as { __hapticPlayTest: PlayTest }).__hapticPlayTest;
  const rendering = host.rendering();
  return {
    canvas: [node.width, node.height], css: [node.clientWidth, node.clientHeight], ratio: window.devicePixelRatio,
    world: rendering ? [rendering.width, rendering.height] : null,
    backend: rendering?.pipeline.effective.gpuBackend ?? null,
    profile: host.scalability()?.effective?.render.quality?.resolution.profile ?? null,
  };
});

/**
 * The red channel across the middle row of the Play canvas: the layer's white panel on the black world. Its edges
 * are where the row crosses half brightness; `profiles` holds the pixels around each.
 */
const rowEdges = (page: Page) => page.getByTestId("play-canvas").evaluate((node: HTMLCanvasElement) => {
  const copy = document.createElement("canvas");
  copy.width = node.width; copy.height = node.height;
  const context = copy.getContext("2d")!;
  context.drawImage(node, 0, 0);
  const row = context.getImageData(0, Math.floor(copy.height / 2), copy.width, 1).data;
  const red = Array.from({ length: copy.width }, (_, x) => row[x * 4]!);
  const edges: number[] = [];
  for (let x = 1; x < red.length; x += 1) if ((red[x - 1]! < 128) !== (red[x]! < 128)) edges.push(x);
  const profiles = edges.map((x) => red.slice(Math.max(0, x - 6), x + 6));
  return { edges, profiles };
});

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`a Scene Layer keeps its device-pixel size and sharpness at the Low and High tiers and a reduced render scale on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const files = await minimalProjectFiles();
    const versions = createDefaultMigrationRegistry();
    const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!)) as ProjectDocument;
    project.settings.render = normalizeRenderProjectSettings({ gpuBackend: backend, shadows: { enabled: false } });
    files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
    const layerGuid = "00000000-0000-4000-8000-000000000041";
    const materialGuid = "00000000-0000-4000-8000-000000000042";
    const classGuid = "00000000-0000-4000-8000-000000000002";
    const material = createDefaultMaterialDocument("Panel White");
    material.shadingModel = "unlit";
    material.nodes[0]!.properties.value = [1, 1, 1];
    files.set("assets/PanelWhite.material.hasset", await encodeAssetDocument({
      guid: materialGuid, type: "Material", name: "Panel White", version: versions.currentVersion("Material"), payload: material as unknown as Record<string, unknown>,
    }));
    // A panel whose left and right edges cross the middle row, on the left of the view.
    const components: SerializedComponent[] = [
      { id: "panel", classId: "2DMaterialComponent", properties: { materialGuid },
        transform: { position: [-7, 0, 0], rotation: [0, 0, 0, 1], scale: [5.3, 6, 1] } },
    ];
    files.set(MAIN_CLASS_FILE, await encodeAssetDocument({
      guid: classGuid, type: "Class", name: "Main", version: versions.currentVersion("Class"),
      payload: { members: [], components, nodes: [], edges: [] } as unknown as Record<string, unknown>,
    }, { parentClass: "SceneLayerActor", dependencies: [materialGuid] }));
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("panel-hud", "Panel HUD", { classId: "main", components })];
    files.set("assets/PanelHud.scenelayer.hasset", await encodeAssetDocument({
      guid: layerGuid, type: "SceneLayer", name: "Panel HUD", version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown>,
    }, { dependencies: [classGuid, materialGuid] }));
    const scene = createDefaultScene();
    scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
    scene.settings.environmentColor = [0, 0, 0];
    scene.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 0, enabled: true }];
    files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
      guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
    }, { dependencies: [layerGuid] }));
    await openMinimalTestProject(page, files);
    await showOverlayButtons(page, ["console"]);
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect.poll(async () => (await sizes(page)).backend, { timeout: 30_000 }).toBe(backend);
    await page.getByTestId("play-console-open").click();
    const command = async (line: string) => {
      await page.getByTestId("debug-console-input").fill(line);
      await page.getByTestId("debug-console-submit").click();
      await expect(page.getByTestId("debug-console-input")).toHaveValue("");
    };
    /** The row's two panel edges once they hold still for consecutive reads. */
    const settledEdges = async () => {
      let previous = "";
      let edges: Awaited<ReturnType<typeof rowEdges>> | null = null;
      await expect.poll(async () => {
        edges = await rowEdges(page);
        const signature = JSON.stringify(edges);
        const stable = signature === previous && edges.edges.length === 2;
        previous = signature;
        return stable;
      }, { timeout: 30_000, intervals: [250] }).toBe(true);
      return edges!;
    };

    await command("quality high");
    await expect.poll(async () => (await sizes(page)).profile, { timeout: 30_000 }).toBe("high");
    const high = await sizes(page);
    // The backbuffer is the canvas's device pixels.
    expect(high.ratio).toBe(2);
    expect(high.canvas).toEqual([Math.floor(high.css[0]! * 2), Math.floor(high.css[1]! * 2)]);
    const highEdges = await settledEdges();

    await command("quality low");
    await expect.poll(async () => (await sizes(page)).profile, { timeout: 30_000 }).toBe("low");
    const low = await sizes(page);
    // Low renders the world below the CSS size (render scale 0.85 at most); the canvas keeps its pixels.
    expect(low.world![0]).toBeLessThanOrEqual(Math.floor(low.css[0]! * 0.85));
    expect(low.canvas).toEqual(high.canvas);
    const lowEdges = await settledEdges();

    await command("quality resolution scale 0.25");
    const quarter = [Math.floor(high.css[0]! / 4), Math.floor(high.css[1]! / 4)];
    await expect.poll(async () => (await sizes(page)).world, { timeout: 30_000 }).toEqual(quarter);
    const reduced = await sizes(page);
    expect(reduced.canvas).toEqual(high.canvas);
    const reducedEdges = await settledEdges();

    await testInfo.attach("scene-layer-edges", {
      body: JSON.stringify({ high, low, reduced, highEdges, lowEdges, reducedEdges }), contentType: "application/json",
    });
    await page.getByTestId("play-canvas").screenshot({ path: testInfo.outputPath(`scene-layer-reduced-${backend}.png`) });
    // The panel's edges sit on the same pixels with the same falloff: a layer drawn at the world's reduced size and
    // stretched would move them and spread each over several pixels.
    for (const edges of [lowEdges, reducedEdges]) {
      expect(edges.edges).toEqual(highEdges.edges);
      edges.profiles.forEach((profile, index) => {
        profile.forEach((value, x) => expect(Math.abs(value - highEdges.profiles[index]![x]!)).toBeLessThanOrEqual(2));
      });
    }
    // At device pixels the panel's edges are hard: at most one partly covered pixel at each.
    for (const profile of highEdges.profiles)
      expect(profile.filter((value) => value > 8 && value < 247).length).toBeLessThanOrEqual(1);
    await page.getByTestId("play-overlay-close").click();
    expect(errors).toEqual([]);
  });
}
