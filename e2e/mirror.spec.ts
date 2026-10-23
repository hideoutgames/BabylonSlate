import { expect, test, type Locator } from "@playwright/test";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { readHassetHeader } from "../packages/assets/src/hasset";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  createActor, createMeshComponent, identitySerializedTransform, MAIN_SCENE_FILE, parseMirrorProperties, type SerializedScene,
} from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

type ViewportHost = { __hapticViewportTest: { setShadowCaptureView(position: number[], target: number[], fov: number): void } };

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

test("a Mirror shows an object behind the camera in the editor viewport and in Play, built in and through a Mirror Reflection Material", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|INVALID_OPERATION|feedback loop|Mirror reflection/i.test(message.text())) errors.push(message.text());
  });
  const files = await minimalProjectFiles();
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
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument(
    { ...decoded, payload: scene as unknown as Record<string, unknown> },
    { dependencies: [...readHassetHeader(sceneFile).dependencies, materialGuid] },
  ));

  await openMinimalTestProject(page, files);
  await openMainScene(page);
  // The editor view looks down at the mirror from just in front of the scene camera (and its camera model).
  await page.evaluate(() => (window as unknown as ViewportHost).__hapticViewportTest.setShadowCaptureView([0, 2.6, -3], [0, 2, 0], 0.8));
  await expectReflected(page.getByTestId("viewport-canvas"), "mirror-editor", "red");

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
  expect(errors).toEqual([]);
});
