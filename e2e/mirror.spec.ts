import { expect, test, type Locator } from "@playwright/test";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { readHassetHeader } from "../packages/assets/src/hasset";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  createActor, createMeshComponent, createText3DComponent, identitySerializedTransform, MAIN_SCENE_FILE, normalizeRenderingQuality,
  parseMirrorProperties, parseReflectionProbeProperties, type MirrorReflects, type SerializedScene,
} from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { PROJECT_FILE } from "../packages/core/src/project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type ViewportHost = {
  __hapticViewportTest: {
    setShadowCaptureView(position: number[], target: number[], fov: number): void;
    renderingBaseline(): { backend: string } | null;
    mirrorDiagnostics(): { draws: number; reuses: number; drawnMeshes: number; shadowPasses: number; sunShadowViews: number } | null;
    setMirrorFootprintCulling(enabled: boolean): void;
  };
};

/** Average colour of a tenth of the canvas, centred at `x` of its width: by default its middle, the middle of the mirror. */
async function centerColor(canvas: Locator, x = 0.5): Promise<number[]> {
  return canvas.evaluate((node: HTMLCanvasElement, at: number) => {
    // Read a copy: reading the view canvas itself would change how the browser backs it.
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const ctx = copy.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(node, 0, 0);
    const data = ctx.getImageData(Math.floor(node.width * (at - 0.05)), Math.floor(node.height * 0.45), Math.max(1, Math.floor(node.width * 0.1)), Math.max(1, Math.floor(node.height * 0.1))).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) sum[channel] += data[i + channel]!;
    return sum.map((value) => value / (data.length / 4));
  }, x);
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
  const camera = scene.actors.find((actor) => actor.id === scene.settings.defaultCameraActorId)!;
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
  const camera = scene.actors.find((actor) => actor.id === scene.settings.defaultCameraActorId)!;
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
  // Counted before the toggle, as `start` is: at a high viewport frame rate its redraw can land before a read after it.
  const beforeCropping = await mirrors();
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setMirrorFootprintCulling(true));
  expect((await settled(beforeCropping)).hash).toBe(cropped.hash);
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
  const camera = scene.actors.find((actor) => actor.id === scene.settings.defaultCameraActorId)!;
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

/** Mean brightness of the canvas's central tenth (the middle of the mirror): the mean of its channels' averages. */
async function centerBrightness(canvas: Locator): Promise<number> {
  const [r, g, b] = await centerColor(canvas);
  return (r! + g! + b!) / 3;
}

for (const backend of ["webgl2", "webgpu"] as const) test(`a Mirror shows the sun's shadow on what only it shows with Reflection Shadows on, and none with them off, on ${backend}`, async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|INVALID_OPERATION|feedback loop|Mirror reflection|outlived|do not fit the shadow atlas/i.test(message.text())) errors.push(message.text());
  });
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = backend;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  // A plain lit white floor: the default box's checker grid would hide the shadow's edge in the sampled region.
  const whiteGuid = "00000000-0000-4000-8000-000000000032";
  const white = createDefaultMaterialDocument("White");
  white.nodes.find((node) => node.id === "baseColor")!.properties.value = [1, 1, 1];
  files.set("assets/White.material.hasset", await encodeAssetDocument({
    guid: whiteGuid, type: "Material", name: "White", version: MATERIAL_PAYLOAD_VERSION, payload: white as unknown as Record<string, unknown>,
  }));
  const sceneFile = files.get(MAIN_SCENE_FILE)!;
  const decoded = await decodeAssetDocument(sceneFile);
  const scene = decoded.payload as unknown as SerializedScene;
  const camera = scene.actors.find((actor) => actor.id === scene.settings.defaultCameraActorId)!;
  camera.transform = { ...identitySerializedTransform(), position: [0, 2, -4] };
  const box = (id: string, position: [number, number, number], scale: [number, number, number], materialGuid?: string) => {
    const mesh = createMeshComponent(`${id}-mesh`, "box");
    if (materialGuid) mesh.properties = { ...mesh.properties, materialGuid };
    return createActor(id, id, { transform: { ...identitySerializedTransform(), position, scale }, components: [mesh] });
  };
  scene.actors = [
    camera,
    createActor("mirror", "Mirror", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [{ id: "mirror-surface", classId: "MirrorComponent", properties: { ...parseMirrorProperties({ width: 6, height: 4 }) }, parentId: null, transform: identitySerializedTransform() }],
    }),
    // Behind the camera, seen only in the mirror: a white floor, whose part from 7.5 m to 13.5 m behind the mirror fills
    // the middle of the view, under a slab high enough for the reflected view to pass beneath it.
    box("floor", [0, -0.1, -10], [10, 0.2, 12], whiteGuid),
    box("slab", [0, 3, -10.5], [4, 0.2, 9]),
    createActor("sun", "Sun", {
      // Pointing down, tilted 10 degrees toward +Z.
      transform: { ...identitySerializedTransform(), position: [0, 10, -10], rotation: [Math.sin(Math.PI * 2 / 9), 0, 0, Math.cos(Math.PI * 2 / 9)] },
      components: [{
        id: "sun-light", classId: "LightComponent", parentId: null, transform: identitySerializedTransform(),
        properties: { lightKind: "directional", color: [1, 1, 1], intensity: 2, enabled: true, castShadows: true },
      }],
    }),
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument(
    { ...decoded, payload: scene as unknown as Record<string, unknown> },
    { dependencies: [...readHassetHeader(sceneFile).dependencies, whiteGuid] },
  ));

  await openMinimalTestProject(page, files);
  await openMainScene(page);
  expect(await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.renderingBaseline()?.backend)).toBe(backend);
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  const viewport = page.getByTestId("viewport-canvas");
  const mirrors = () => page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.mirrorDiagnostics()!);
  /** Waits until renders keep the reflection (its own sun maps unchanged too) and the mirror's middle holds still; its brightness then. */
  const settled = async () => {
    let brightness = 0;
    await expect.poll(async () => {
      const before = await mirrors(), first = await centerBrightness(viewport);
      await page.waitForTimeout(500);
      const after = await mirrors();
      brightness = await centerBrightness(viewport);
      return after.draws > 0 && after.draws === before.draws && after.reuses > before.reuses && Math.abs(brightness - first) < 1;
    }, { timeout: 60_000 }).toBe(true);
    return brightness;
  };
  const reflectionShadows = async (on: boolean) => {
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    const section = page.getByTestId("settings-modal").getByRole("button", { name: "Shadows", exact: true });
    if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
    const toggle = page.getByTestId("settings-modal").getByRole("switch", { name: "Reflection Shadows", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", String(on));
    await page.getByTestId("settings-modal").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Project Settings" })).toBeHidden();
    await waitForSceneViewportReady(page);
    await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  };
  const moveSlabX = async (x: number) => {
    await page.getByTestId("tree-row-actor:slab").click();
    await page.getByTestId("property-actor-position-x").fill(String(x));
    await page.getByTestId("property-actor-position-x").press("Enter");
  };

  // Off (the project's Medium shadows): the reflection draws the sun unshadowed, slab or not.
  const offWithSlab = await settled();
  expect((await mirrors()).sunShadowViews).toBe(0);
  await reflectionShadows(true);
  const onWithSlab = await settled();
  expect((await mirrors()).sunShadowViews).toBe(1);
  await page.screenshot({ path: testInfo.outputPath(`reflection-shadows-on-${backend}.png`) });
  await moveSlabX(40);
  const onWithoutSlab = await settled();
  await reflectionShadows(false);
  const offWithoutSlab = await settled();
  expect((await mirrors()).sunShadowViews).toBe(0);
  const measured = { backend, offWithSlab, onWithSlab, onWithoutSlab, offWithoutSlab };
  console.log(`reflection-shadows ${JSON.stringify(measured)}`);
  await testInfo.attach(`reflection-shadows-${backend}`, { body: JSON.stringify(measured, null, 2), contentType: "application/json" });
  // On, the slab's shadow darkens the reflected floor clearly; off, the slab changes nothing there.
  expect(onWithoutSlab - onWithSlab).toBeGreaterThan(30);
  expect(Math.abs(offWithoutSlab - offWithSlab)).toBeLessThan(4);
  // Without the slab, the floor is as bright either way.
  expect(Math.abs(onWithoutSlab - offWithoutSlab)).toBeLessThan(4);
  expect(errors).toEqual([]);
});

/**
 * A Mirror inside a Reflection Probe's box, facing a red wall whose actor never moves and, in front of it, a blue box
 * whose actor can (it has a body that is not static). What the Mirror draws live follows its Reflects property, and
 * the rest comes from the probe: the middle of the Mirror shows the box or, when nothing is drawn live, the wall
 * behind it; a quarter of the view to the side shows the wall, drawn or from the probe. The quality level's cap does
 * the same to a Mirror that asks for everything.
 */
for (const backend of ["webgl2", "webgpu"] as const) test(`a Mirror draws what its Reflects property and the quality level's cap say, and shows the rest from its Reflection Probe, on ${backend}`, async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|INVALID_OPERATION|feedback loop|Mirror reflection|outlived/i.test(message.text())) errors.push(message.text());
  });
  const dominant = (color: number[]) => {
    const [r, g, b] = color as [number, number, number];
    return Math.min(r - g, r - b) > 80 ? "red" : Math.min(b - g, b - r) > 80 ? "blue" : `neither (${color.map(Math.round).join(", ")})`;
  };
  for (const [reflects, middle, meshes] of [["everything", "blue", "several"], ["movingActors", "blue", "one"], ["environment", "red", "none"]] as const) {
    const files = await minimalProjectFiles();
    const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
    project.settings.render.gpuBackend = backend;
    files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
    const unlit = async (guid: string, name: string, color: [number, number, number]) => {
      const material = createDefaultMaterialDocument(name);
      material.shadingModel = "unlit";
      material.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      files.set(`assets/${name}.material.hasset`, await encodeAssetDocument({
        guid, type: "Material", name, version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
      }));
      return guid;
    };
    const red = await unlit("00000000-0000-4000-8000-000000000040", "Red", [1, 0, 0]);
    const blue = await unlit("00000000-0000-4000-8000-000000000041", "Blue", [0, 0, 1]);
    const sceneFile = files.get(MAIN_SCENE_FILE)!;
    const decoded = await decodeAssetDocument(sceneFile);
    const scene = decoded.payload as unknown as SerializedScene;
    const camera = scene.actors.find((actor) => actor.id === scene.settings.defaultCameraActorId)!;
    camera.transform = { ...identitySerializedTransform(), position: [0, 2, -4] };
    const mesh = (id: string, materialGuid: string) => {
      const component = createMeshComponent(id, "box");
      component.properties = { ...component.properties, materialGuid };
      return component;
    };
    scene.actors = [
      camera,
      createActor("mirror", "Mirror", {
        transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
        components: [{ id: "mirror-surface", classId: "MirrorComponent", properties: { ...parseMirrorProperties({ width: 6, height: 4, reflects }) }, parentId: null, transform: identitySerializedTransform() }],
      }),
      createActor("wall", "Wall", {
        transform: { ...identitySerializedTransform(), position: [0, 2, -14], scale: [40, 24, 0.5] },
        components: [mesh("wall-mesh", red)],
      }),
      createActor("mover", "Mover", {
        transform: { ...identitySerializedTransform(), position: [0, 2, -9], scale: [3, 3, 3] },
        components: [mesh("mover-mesh", blue), { id: "mover-body", classId: "RigidBodyComponent", properties: { motionType: "kinematic", mass: 0, gravityScale: 0 }, parentId: null }],
      }),
      // Its box holds the Mirror and ends just behind the wall.
      createActor("probe", "Reflection Probe", {
        transform: { ...identitySerializedTransform(), position: [0, 2, -6] },
        components: [{ id: "probe-box", classId: "ReflectionProbeComponent", properties: { ...parseReflectionProbeProperties({ size: [44, 28, 20] }) }, parentId: null }],
      }),
    ];
    files.set(MAIN_SCENE_FILE, await encodeAssetDocument(
      { ...decoded, payload: scene as unknown as Record<string, unknown> },
      { dependencies: [...readHassetHeader(sceneFile).dependencies, red, blue] },
    ));
    await openMinimalTestProject(page, files);
    await openMainScene(page);
    expect(await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.renderingBaseline()?.backend)).toBe(backend);
    await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2, -4], [0, 2, 0], 0.8));
    const viewport = page.getByTestId("viewport-canvas");
    try {
      await expect.poll(async () => `${dominant(await centerColor(viewport))} in the middle, ${dominant(await centerColor(viewport, 0.25))} to the side`,
        { timeout: 60_000 }).toBe(`${middle} in the middle, red to the side`);
    } finally {
      await viewport.screenshot({ path: test.info().outputPath(`mirror-${reflects}-${backend}.png`) });
    }
    const drawn = await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.mirrorDiagnostics());
    const perDraw = drawn && drawn.draws ? drawn.drawnMeshes / drawn.draws : 0;
    // Everything draws the wall and the box at least; Moving Actors the box alone; Environment draws no reflection.
    expect(perDraw === 0 ? "none" : perDraw === 1 ? "one" : "several", `${reflects}: ${JSON.stringify(drawn)}`).toBe(meshes);
    if (reflects !== "everything") continue;
    // The quality level's cap, switched while playing: with no reflection drawn the Mirror shows the wall where the box
    // was, from the probe, and with no cap the box again.
    await clickPlayAndWaitForOverlay(page);
    const play = page.getByTestId("play-canvas");
    const middleInPlay = (color: string) => expect.poll(async () => dominant(await centerColor(play)), { timeout: 60_000 }).toBe(color);
    const cap = (mirrorReflections: MirrorReflects) => page.evaluate(
      (quality) => (window as unknown as { __hapticPlayTest: { setRenderSettings(settings: { quality: unknown }): void } }).__hapticPlayTest.setRenderSettings({ quality }),
      normalizeRenderingQuality({ geometry: { mirrorReflections } }),
    );
    try {
      await middleInPlay("blue");
      await cap("environment");
      await middleInPlay("red");
      await cap("everything");
      await middleInPlay("blue");
    } finally {
      await play.screenshot({ path: test.info().outputPath(`mirror-cap-play-${backend}.png`) });
    }
    await page.getByTestId("play-overlay-close").click();
  }
  expect(errors).toEqual([]);
});
