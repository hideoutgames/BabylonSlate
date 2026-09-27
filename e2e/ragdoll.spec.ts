import { expect, test, type Page } from "@playwright/test";
import { createActor, createMeshComponent, eulerDegreesToQuaternion, lookAtRotation, type SerializedScene } from "../packages/core/src/index";
import type { ShadowDiagnostics } from "../packages/render/src/index";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";
import { saveAllIfEnabled } from "./save-all";

const PARTS = ["head", "torso", "arm-left", "arm-right", "leg-left", "leg-right"];
type Pose = Record<string, number[]>;
type TestHost = {
  __babylonslateTest: { activeSceneContent(): SerializedScene };
  __babylonslateViewportTest: { shadowDiagnostics(): ShadowDiagnostics | null };
  __babylonslatePlayTest?: {
    shadowDiagnostics(): ShadowDiagnostics | null;
    whenModelsReady(): Promise<void>;
    runtimeMode(): "worker" | "in-process" | null;
    inspectWorld(): Promise<{ nodes: { classId: string; parentId?: string; variables: Record<string, unknown> }[] }>;
  };
};

/** Read matrices already produced by the real renderer, without moving its nodes. */
async function pose(page: Page, playing: boolean): Promise<Pose> {
  return page.evaluate(({ parts, playing }) => {
    const host = globalThis as unknown as TestHost;
    const api = playing ? host.__babylonslatePlayTest : host.__babylonslateViewportTest;
    return Object.fromEntries((api?.shadowDiagnostics()?.models ?? [])
      .filter(mesh => parts.includes(mesh.name ?? ""))
      .map(mesh => {
        const matrix = mesh.worldMatrix;
        if (!matrix || matrix.length !== 16 || matrix.some(value => value === null || !Number.isFinite(value))) {
          throw new Error(`Invalid rendered matrix for ${mesh.name}`);
        }
        return [mesh.name!, matrix as number[]];
      }));
  }, { parts: PARTS, playing });
}

/** Relative limb directions remove whole-character translation and rotation. */
function articulation(pose: Pose): number[] {
  const torso = pose.torso!;
  const axis = (matrix: number[], offset: number) => {
    const vector = matrix.slice(offset, offset + 3);
    const length = Math.hypot(...vector);
    return vector.map(value => value / length);
  };
  return PARTS.filter(name => name !== "torso").flatMap(name => {
    const limb = axis(pose[name]!, 4);
    return [0, 4, 8].map(offset => axis(torso, offset).reduce((dot, value, index) => dot + value * limb[index]!, 0));
  });
}

test("a UI-authored ragdoll articulates the real Mannequin in worker Play and stops cleanly", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openTestProject(page);
  await openMainScene(page);
  const scene = await page.evaluate(() => (globalThis as unknown as TestHost).__babylonslateTest.activeSceneContent());
  const actor = scene.actors.find(entry => entry.id === "actor-1")!;
  expect(actor.components.some(component => component.classId === "AnimationGraphComponent")).toBe(true);
  expect(actor.components.find(component => component.classId === "MeshComponent")?.properties.assetGuid).toBeTruthy();
  // Keep the starter's imported hierarchy and animation, but omit its movement script.
  actor.classId = "Actor";
  actor.transform.position = [0, 4, 0];
  actor.transform.rotation = eulerDegreesToQuaternion([0, 0, 25]);
  const floor = createActor("ragdoll-floor", "Ragdoll Floor", {
    components: [createMeshComponent("ragdoll-floor-mesh", "box")],
  });
  floor.transform.position = [0, -0.5, 0];
  floor.transform.scale = [20, 1, 20];
  scene.actors.push(floor);
  const camera = scene.actors.find(entry => entry.id === scene.settings.mainCameraActorId)!;
  camera.transform.position = [6, 5, 9];
  camera.transform.rotation = lookAtRotation([6, 5, 9], [0, 2, 0]);
  camera.components.find(component => component.classId === "CameraComponent")!.properties.fieldOfView = 50;
  await setPreviewScene(page, scene);

  await page.getByTestId("tree-row-actor:actor-1").click();
  await page.getByTestId("details-add-component").click();
  await page.getByTestId("add-component-catalog-item-RagdollComponent").click();
  const ragdoll = await page.evaluate(() => (globalThis as unknown as TestHost).__babylonslateTest.activeSceneContent()
    .actors.find(entry => entry.id === "actor-1")!.components.find(component => component.classId === "RagdollComponent")!);
  expect(ragdoll.properties.enabled).toBe(false);
  expect(ragdoll.properties.boneNames).toEqual([]);
  await page.getByTestId(`property-actor-1-${ragdoll.id}-enabled`).click();
  await expect.poll(() => page.evaluate((id) => (globalThis as unknown as TestHost).__babylonslateTest.activeSceneContent()
    .actors.find(entry => entry.id === "actor-1")!.components.find(component => component.id === id)!.properties.enabled, ragdoll.id)).toBe(true);
  await saveAllIfEnabled(page);
  await expect.poll(async () => Object.keys(await pose(page, false)).length, { timeout: 30_000 }).toBe(6);
  const before = await pose(page, false);

  await clickPlayAndWaitForOverlay(page);
  await page.evaluate(() => (globalThis as unknown as TestHost).__babylonslatePlayTest!.whenModelsReady());
  expect(await page.evaluate(() => (globalThis as unknown as TestHost).__babylonslatePlayTest!.runtimeMode())).toBe("worker");
  await expect.poll(async () => page.evaluate(async () => {
    const snapshot = await (globalThis as unknown as TestHost).__babylonslatePlayTest!.inspectWorld();
    return snapshot.nodes.find(node => node.classId === "RagdollComponent" && node.parentId === "actor-1")?.variables.status;
  }), { timeout: 30_000 }).toBe("active");
  await expect.poll(async () => {
    const current = await pose(page, true);
    if (Object.keys(current).length !== 6) return false;
    const baseline = articulation(before);
    const changed = articulation(current).some((value, index) => Math.abs(value - baseline[index]!) > 0.15);
    return current.torso![13]! < before.torso![13]! - 2 && changed;
  }, { timeout: 20_000 }).toBe(true);
  const after = await pose(page, true);
  expect(after.torso![13]!).toBeGreaterThan(-1);
  // Tan pixels are the actual imported model, independent of inspector state.
  await expect.poll(() => page.getByTestId("play-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let pixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const [r, g, b] = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
      if (r > 70 && g > 30 && r > g * 1.12 && g > b * 1.1) pixels++;
    }
    return pixels;
  }), { timeout: 10_000 }).toBeGreaterThan(100);
  await testInfo.attach("mannequin-ragdoll-poses", { body: JSON.stringify({ before, after }), contentType: "application/json" });
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as TestHost).__babylonslatePlayTest === undefined)).toBe(true);
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("preview-session-report")).toHaveCount(0);
  await expect.poll(async () => Object.keys(await pose(page, false)).length).toBe(6);
  expect(errors).toEqual([]);
});
