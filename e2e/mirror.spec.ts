import { expect, test, type Locator } from "@playwright/test";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { readHassetHeader } from "../packages/assets/src/hasset";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  createActor, createMeshComponent, createText3DComponent, identitySerializedTransform, MAIN_SCENE_FILE, parseMirrorProperties, type SerializedScene,
} from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { PROJECT_FILE } from "../packages/core/src/project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type ViewportHost = {
  __hapticViewportTest: {
    setShadowCaptureView(position: number[], target: number[], fov: number): void;
    renderingBaseline(): { backend: string } | null;
    mirrorDiagnostics(): { draws: number; reuses: number; drawnMeshes: number; shadowPasses: number } | null;
    setMirrorFootprintCulling(enabled: boolean): void;
  };
};

/** Average colour of the canvas's central tenth: the middle of the mirror. */
async function centerColor(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    // Read a copy: reading the view canvas itself would change how the browser backs it.
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const ctx = copy.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(node, 0, 0);
    const data = ctx.getImageData(Math.floor(node.width * 0.45), Math.floor(node.height * 0.45), Math.max(1, Math.floor(node.width * 0.1)), Math.max(1, Math.floor(node.height * 0.1))).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) sum[channel] += data[i + channel]!;
    return sum.map((value) => value / (data.length / 4));
  });
}

/**
 * One channel dominates the middle of the mirror: red where it shows the red box, which stands behind the camera and
 * is only visible reflected; blue where the override Material swaps the reflection's red and blue.
 */
async function expectReflected(canvas: Locator, name: string, channel: "red" | "blue"): Promise<void> {
  try {
    await expect.poll(async () => {
      const [r, g, b] = await centerColor(canvas);
      return channel === "red" ? Math.min(r! - g!, r! - b!) : Math.min(b! - g!, b! - r!);
    }, { timeout: 30_000 }).toBeGreaterThan(80);
  } finally {
    await canvas.screenshot({ path: test.info().outputPath(`${name}.png`) });
  }
}

for (const backend of ["webgl2", "webgpu"] as const) test(`a Mirror shows an object behind the camera in the editor, Play and Preview Build, built in and through a Mirror Reflection Material, on ${backend}`, async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|INVALID_OPERATION|feedback loop|Mirror reflection|outlived/i.test(message.text())) errors.push(message.text());
  });
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = backend;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const materialGuid = "00000000-0000-4000-8000-000000000030";
  const material = createDefaultMaterialDocument("Red");
  material.shadingModel = "unlit";
  material.nodes.find((node) => node.id === "baseColor")!.properties.value = [1, 0, 0];
  files.set("assets/Red.material.hasset", await encodeAssetDocument({
    guid: materialGuid, type: "Material", name: "Red", version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
  }));
  // A Material override that shows the reflection through the node, slightly offset, with red and blue swapped.
  const glassGuid = "00000000-0000-4000-8000-000000000031";
  const glass = createDefaultMaterialDocument("Mirror Glass");
  glass.shadingModel = "unlit";
  glass.nodes = [
    ...glass.nodes.filter((node) => node.id === "output"),
    { id: "reflection", type: "input.mirrorReflection", position: { x: 0, y: 0 }, properties: { "default:offset": [0.01, 0] } },
    { id: "split", type: "vector.split", position: { x: 200, y: 0 }, properties: {} },
    { id: "swapped", type: "vector.combine", position: { x: 400, y: 0 }, properties: {} },
  ];
  glass.edges = [
    { id: "reflection-split", sourceNodeId: "reflection", sourcePinId: "color", targetNodeId: "split", targetPinId: "value" },
    { id: "blue-to-red", sourceNodeId: "split", sourcePinId: "z", targetNodeId: "swapped", targetPinId: "x" },
    { id: "green", sourceNodeId: "split", sourcePinId: "y", targetNodeId: "swapped", targetPinId: "y" },
    { id: "red-to-blue", sourceNodeId: "split", sourcePinId: "x", targetNodeId: "swapped", targetPinId: "z" },
    { id: "swapped-base", sourceNodeId: "swapped", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "baseColor" },
  ];
  files.set("assets/MirrorGlass.material.hasset", await encodeAssetDocument({
    guid: glassGuid, type: "Material", name: "Mirror Glass", version: MATERIAL_PAYLOAD_VERSION, payload: glass as unknown as Record<string, unknown>,
  }));
  const sceneFile = files.get(MAIN_SCENE_FILE)!;
  const decoded = await decodeAssetDocument(sceneFile);
  const scene = decoded.payload as unknown as SerializedScene;
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId)!;
  camera.transform = { ...identitySerializedTransform(), position: [0, 2, -4] };
  const box = createMeshComponent("red-box-mesh", "box");
  // Static unlit Text 3D beside the box, inside the reflection: it must not keep the reflection redrawing.
  const label = createText3DComponent("label-text");
  label.properties = { ...label.properties, text: "Haptic", size: 0.6 };
  box.properties = { ...box.properties, materialGuid };
  scene.actors = [
    camera,
    // The mirror's reflective side (local -Z) faces the camera; the box stands behind the camera.
    createActor("mirror", "Mirror", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [{ id: "mirror-surface", classId: "MirrorComponent", properties: { ...parseMirrorProperties({ width: 6, height: 4 }) }, parentId: null, transform: identitySerializedTransform() }],
    }),
    createActor("red-box", "Red Box", {
      transform: { ...identitySerializedTransform(), position: [0, 2, -10], scale: [4, 4, 4] },
      components: [box],
    }),
    createActor("label", "Label", {
      transform: { ...identitySerializedTransform(), position: [-1.5, 3, -7] },
      components: [label],
    }),
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument(
    { ...decoded, payload: scene as unknown as Record<string, unknown> },
    { dependencies: [...readHassetHeader(sceneFile).dependencies, materialGuid] },
  ));

  await openMinimalTestProject(page, files);
  await openMainScene(page);
  expect(await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.renderingBaseline()?.backend)).toBe(backend);
  // The editor view looks down at the mirror from just in front of the scene camera (and its camera model).
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  await expectReflected(page.getByTestId("viewport-canvas"), "mirror-editor", "red");

  // A static view keeps its reflection, the unlit Text 3D in it included: renders reuse it, draw nothing, and the mirror shows the same pixels.
  const viewport = page.getByTestId("viewport-canvas");
  const mirrors = () => page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.mirrorDiagnostics()!);
  await expect.poll(async () => {
    const before = await mirrors(), color = await centerColor(viewport);
    await page.waitForTimeout(500);
    const after = await mirrors(), again = await centerColor(viewport);
    return after.draws === before.draws && after.reuses > before.reuses && color.every((value, i) => Math.abs(value - again[i]!) < 1);
  }, { timeout: 30_000 }).toBe(true);
  // Moving the box out of the reflection draws it again on the next render, and moving it back shows it again.
  await page.getByTestId("tree-row-actor:red-box").click();
  await page.getByTestId("property-actor-position-x").fill("40");
  await page.getByTestId("property-actor-position-x").press("Enter");
  await expect.poll(async () => { const [r, g, b] = await centerColor(viewport); return r! - Math.max(g!, b!); }, { timeout: 30_000 }).toBeLessThan(40);
  await page.getByTestId("property-actor-position-x").fill("0");
  await page.getByTestId("property-actor-position-x").press("Enter");
  await expectReflected(viewport, "mirror-editor-moved-back", "red");

  await clickPlayAndWaitForOverlay(page);
  await expectReflected(page.getByTestId("play-canvas"), "mirror-play", "red");
  await page.getByTestId("play-overlay-close").click();

  // The same reflection through a Material override's Mirror Reflection node.
  await page.getByTestId("tree-row-actor:mirror").click();
  await page.getByTestId("property-mirror-mirror-surface-materialGuid").click();
  await page.getByTestId(`search-item-${glassGuid}`).click();
  await expect(page.getByTestId("property-mirror-mirror-surface-materialGuid")).toContainText("Mirror Glass");
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  await expectReflected(page.getByTestId("viewport-canvas"), "mirror-node-editor", "blue");
  await clickPlayAndWaitForOverlay(page);
  await expectReflected(page.getByTestId("play-canvas"), "mirror-node-play", "blue");
  await page.getByTestId("play-overlay-close").click();

  // The packed player draws the same reflection from its own Engine.
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  await expectReflected(page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas"), "mirror-node-preview-build", "blue");
  expect(errors).toEqual([]);
});

/** A hash of every pixel of the canvas (read from a copy, as `centerColor` does). */
async function canvasHash(canvas: Locator): Promise<string> {
  return canvas.evaluate(async (node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const ctx = copy.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(node, 0, 0);
    const digest = await crypto.subtle.digest("SHA-256", ctx.getImageData(0, 0, node.width, node.height).data);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

for (const backend of ["webgl2", "webgpu"] as const) test(`a Mirror draws only what its footprint can show, with the same pixels as the whole mirrored view, on ${backend}`, async ({ page }) => {
  test.setTimeout(180_000);
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = backend;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const sceneFile = files.get(MAIN_SCENE_FILE)!;
  const decoded = await decodeAssetDocument(sceneFile);
  const scene = decoded.payload as unknown as SerializedScene;
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId)!;
  camera.transform = { ...identitySerializedTransform(), position: [0, 2, -4] };
  const box = (id: string, position: [number, number, number], scale: number) => createActor(id, id, {
    transform: { ...identitySerializedTransform(), position, scale: [scale, scale, scale] },
    components: [createMeshComponent(`${id}-mesh`, "box")],
  });
  scene.actors = [
    camera,
    // A small mirror: its reflection shows the box behind the camera, never the one off to the side, which the whole
    // mirrored view still contains.
    createActor("mirror", "Mirror", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [{ id: "mirror-surface", classId: "MirrorComponent", properties: { ...parseMirrorProperties({ width: 1, height: 1 }) }, parentId: null, transform: identitySerializedTransform() }],
    }),
    box("reflected-box", [0, 2, -10], 4),
    box("side-box", [6, 2, -10], 2),
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ ...decoded, payload: scene as unknown as Record<string, unknown> }));

  await openMinimalTestProject(page, files);
  await openMainScene(page);
  expect(await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.renderingBaseline()?.backend)).toBe(backend);
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  const viewport = page.getByTestId("viewport-canvas");
  const mirrors = () => page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.mirrorDiagnostics()!);
  /** Waits for the reflection to settle (renders reuse it); the canvas then and the meshes per draw since `from`. */
  const settled = async (from: { draws: number; drawnMeshes: number }) => {
    let result = { hash: "", meshesPerDraw: 0 };
    await expect.poll(async () => {
      const before = await mirrors(), hash = await canvasHash(viewport);
      await page.waitForTimeout(500);
      const after = await mirrors(), again = await canvasHash(viewport);
      result = { hash, meshesPerDraw: (after.drawnMeshes - from.drawnMeshes) / Math.max(1, after.draws - from.draws) };
      return after.draws > from.draws && after.draws === before.draws && after.reuses > before.reuses && hash === again;
    }, { timeout: 60_000 }).toBe(true);
    return result;
  };
  const cropped = await settled({ draws: 0, drawnMeshes: 0 });
  const start = await mirrors();
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setMirrorFootprintCulling(false));
  const whole = await settled(start);
  // Byte-identical frames; the whole mirrored view draws the side box too.
  expect(whole.hash).toBe(cropped.hash);
  expect(whole.meshesPerDraw).toBeGreaterThan(cropped.meshesPerDraw);
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setMirrorFootprintCulling(true));
  expect((await settled(await mirrors())).hash).toBe(cropped.hash);
});

for (const backend of ["webgl2", "webgpu"] as const) test(`a Mirror keeps its reflection while a caster whose shadow it cannot show moves, and redraws for one it can, on ${backend}`, async ({ page }) => {
  test.setTimeout(180_000);
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = backend;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const sceneFile = files.get(MAIN_SCENE_FILE)!;
  const decoded = await decodeAssetDocument(sceneFile);
  const scene = decoded.payload as unknown as SerializedScene;
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId)!;
  camera.transform = { ...identitySerializedTransform(), position: [0, 2, -4] };
  const box = (id: string, position: [number, number, number], scale: [number, number, number]) => createActor(id, id, {
    transform: { ...identitySerializedTransform(), position, scale },
    components: [createMeshComponent(`${id}-mesh`, "box")],
  });
  scene.actors = [
    camera,
    createActor("mirror", "Mirror", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [{ id: "mirror-surface", classId: "MirrorComponent", properties: { ...parseMirrorProperties({ width: 2, height: 2 }) }, parentId: null, transform: identitySerializedTransform() }],
    }),
    // Behind the camera, seen only in the mirror: a floor under a spot light. The near caster hangs above what the
    // mirror shows, so only its shadow on the floor is reflected.
    box("floor", [0, -0.1, -9], [8, 0.2, 8]),
    box("near-caster", [0, 6, -9], [1, 1, 1]),
    // Within the light's range, so its map redraws when it moves, but outside its cone and the mirror's view.
    box("far-caster", [10, 1, -9], [1, 1, 1]),
    createActor("spot", "Spot", {
      // Pointing down.
      transform: { ...identitySerializedTransform(), position: [0, 9, -9], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      components: [{
        id: "spot-light", classId: "LightComponent", parentId: null, transform: identitySerializedTransform(),
        properties: { lightKind: "spot", color: [1, 1, 1], intensity: 4, range: 15, innerAngle: 45, outerAngle: 90, enabled: true, castShadows: true },
      }],
    }),
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ ...decoded, payload: scene as unknown as Record<string, unknown> }));

  await openMinimalTestProject(page, files);
  await openMainScene(page);
  expect(await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.renderingBaseline()?.backend)).toBe(backend);
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  const mirrors = () => page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.mirrorDiagnostics()!);
  const settled = () => expect.poll(async () => {
    const before = await mirrors();
    await page.waitForTimeout(500);
    const after = await mirrors();
    return after.draws > 0 && after.draws === before.draws && after.reuses > before.reuses && after.shadowPasses === before.shadowPasses;
  }, { timeout: 60_000 }).toBe(true);
  const moveX = async (actor: string, x: number) => {
    await page.getByTestId(`tree-row-actor:${actor}`).click();
    await page.getByTestId("property-actor-position-x").fill(String(x));
    await page.getByTestId("property-actor-position-x").press("Enter");
  };
  await settled();

  // The far caster's map pass changes no shadow the reflection shows: the reflection is reused.
  const beforeFar = await mirrors();
  await moveX("far-caster", 11);
  await expect.poll(async () => (await mirrors()).shadowPasses, { timeout: 30_000 }).toBeGreaterThan(beforeFar.shadowPasses);
  await settled();
  const afterFar = await mirrors();
  expect(afterFar.draws).toBe(beforeFar.draws);
  expect(afterFar.reuses).toBeGreaterThan(beforeFar.reuses);

  // The near caster's shadow lies on the reflected floor: the reflection draws again.
  await moveX("near-caster", 0.5);
  await expect.poll(async () => (await mirrors()).draws, { timeout: 30_000 }).toBeGreaterThan(afterFar.draws);
});
