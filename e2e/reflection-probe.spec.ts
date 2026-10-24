import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createSkyboxComponent,
  identitySerializedTransform,
  lookAtRotation,
  parseReflectionProbeProperties,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { clickPlayAndWaitForOverlay } from "./play";

const EYE: [number, number, number] = [0, 1.5, -2.5];
const BALL: [number, number, number] = [0, 1.2, 1];

/** Mean blue-minus-red of the canvas centre, where the ball sits: the default sky is blue, the room grey. */
function centreBlueness(canvas: Locator): Promise<number> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    if (!node.width || !node.height) return 0;
    const copy = document.createElement("canvas");
    copy.width = copy.height = 8;
    const context = copy.getContext("2d")!;
    const side = Math.min(node.width, node.height) * 0.08;
    context.drawImage(node, (node.width - side) / 2, (node.height - side) / 2, side, side, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i + 2]! - pixels[i]!;
    return sum / (pixels.length / 4);
  });
}

/**
 * A closed, lightless room around a grey ball, under the default blue sky: only image-based lighting
 * reaches the ball. Without the probe it takes the sky's blue; with it, the captured grey room's,
 * which keeps some blue from the sky lighting its walls.
 */
function room(probe: boolean): SerializedScene {
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.grid.showGrid = false;
  scene.settings.shadowOverrides = { enabled: false };
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId)!;
  camera.transform = { position: EYE, rotation: lookAtRotation(EYE, BALL), scale: [1, 1, 1] };
  const wall = (id: string, position: [number, number, number], scale: [number, number, number]) =>
    createActor(id, id, { transform: { ...identitySerializedTransform(), position, scale }, components: [createMeshComponent(`${id}-mesh`, "box")] });
  scene.actors = [
    camera,
    createActor("sky", "Skybox", { components: [createSkyboxComponent("sky-component")] }),
    wall("floor", [0, -0.1, 0], [8, 0.2, 8]),
    wall("ceiling", [0, 4.1, 0], [8, 0.2, 8]),
    wall("north", [0, 2, 4.1], [8, 4.4, 0.2]),
    wall("south", [0, 2, -4.1], [8, 4.4, 0.2]),
    wall("east", [4.1, 2, 0], [0.2, 4.4, 8]),
    wall("west", [-4.1, 2, 0], [0.2, 4.4, 8]),
    createActor("ball", "Ball", {
      transform: { ...identitySerializedTransform(), position: BALL, scale: [1.2, 1.2, 1.2] },
      components: [createMeshComponent("ball-mesh", "sphere")],
    }),
    createActor("probe", "Reflection Probe", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [{ id: "probe-box", classId: "ReflectionProbeComponent", properties: { ...parseReflectionProbeProperties({ size: [8, 4, 8], enabled: probe }) }, parentId: null }],
    }),
  ];
  return scene;
}

async function aimEditor(page: Page) {
  await page.evaluate(([eye, target]) => (window as unknown as {
    __hapticViewportTest: { setShadowCaptureView(position: number[], target: number[], fov: number): void };
  }).__hapticViewportTest.setShadowCaptureView(eye, target, 0.8), [EYE, BALL] as const);
}

test("a Reflection Probe lights surfaces in its box from the captured room in the editor and Play", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) && /reflection probe|environment (filtering|lighting) failed|GL_INVALID|WebGL: INVALID_/i.test(message.text())) errors.push(message.text());
  });
  await openTestProject(page);
  await openMainScene(page);
  const viewport = page.getByTestId("viewport-canvas");
  const ready = () => expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true", { timeout: 30_000 });

  await setPreviewScene(page, room(false));
  await ready();
  await aimEditor(page);
  await page.waitForTimeout(1_500);
  const skyLit = await centreBlueness(viewport);
  await viewport.screenshot({ path: testInfo.outputPath("probe-off.png") });
  expect(skyLit).toBeGreaterThan(10);

  await setPreviewScene(page, room(true));
  await ready();
  await aimEditor(page);
  // Probes recapture once editing settles, then filter on the GPU.
  try {
    await expect.poll(() => centreBlueness(viewport), { timeout: 30_000 }).toBeLessThan(skyLit * 0.75);
  } finally {
    await viewport.screenshot({ path: testInfo.outputPath("probe-on.png") });
  }

  await clickPlayAndWaitForOverlay(page);
  // The loading dialog covers the ball until the first frame presents.
  await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 60_000 });
  const play = page.getByTestId("play-canvas");
  await expect.poll(() => centreBlueness(play), { timeout: 30_000 }).toBeLessThan(skyLit * 0.75);
  await play.screenshot({ path: testInfo.outputPath("play-probe.png") });
  expect(errors).toEqual([]);
});
