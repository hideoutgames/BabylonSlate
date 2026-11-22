import { expect, test, type Locator, type Page } from "@playwright/test";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { readHassetHeader } from "../packages/assets/src/hasset";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  createMeshComponent, identitySerializedTransform, MAIN_CLASS_FILE, MAIN_SCENE_FILE, parseSpringArmProperties,
  type SerializedComponent, type SerializedGraph, type SerializedScene,
} from "../packages/core/src/index";
import { PREVIEW_CONSOLE_EVENT_MESSAGE } from "../packages/exporter/src/preview-protocol";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { SOFTWARE_GL_ARGS } from "./software-gl";

test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type PlayHost = {
  __hapticPlayTest: {
    tickIndex(): number;
    problemLogs(): Array<{ severity: string; message: string }>;
  };
};

type Vec3 = { x: number; y: number; z: number };
type TraceReport = { hit: boolean; actor: string; origin: Vec3; direction: Vec3; box: Vec3 };
type Rig = "plain" | "arm" | "lag";

const RED_GUID = "00000000-0000-4000-8000-000000000040";
/** Where the red target box (a unit box) starts, in front of every camera below. */
const TARGET: Vec3 = { x: 1.5, y: 0.6, z: 3 };
/** How fast the `lag` rig's box carries its camera along +X, in metres per second. */
const LAG_RIG_SPEED = 0.5;

/** sin and cos of 9 degrees: half the 18 degree pitch of the Feature Test tour camera's arm. */
const HALF_PITCH = { s: Math.sin(Math.PI / 20), c: Math.cos(Math.PI / 20) };

/**
 * The Main Class (the red box's): every touch that begins projects into the Scene and logs, as a warning the test can
 * read, whether it hit, what it hit, the ray it cast and where the box was. `moving` also slides the box along +X.
 */
function traceGraph(components: SerializedComponent[], moving: boolean): SerializedGraph {
  const node = (id: string, type: string, x: number, data: Record<string, unknown> = {}) =>
    ({ id, type, position: { x, y: 0 }, data: { ...data, __nodeType: type } });
  const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
    ({ id: `${source}:${sourceHandle}:${target}:${targetHandle}`, source, sourceHandle, target, targetHandle });
  return {
    nodes: [
      node("began", "input.onTouchBegan", 0),
      node("project", "input.projectTouchToScene", 260, { "default:drawDebug": false }),
      node("name", "actor.getName", 520),
      node("where", "transform.getLocation", 520),
      node("text", "string.format", 520, { "default:format": "TRACE {hit}|{actor}|{origin}|{direction}|{box}" }),
      node("log", "debug.log", 780, { severity: "warning" }),
      ...(moving ? [
        node("tick", "flow.event.tick", 0),
        node("step", "math.mul", 260, { "default:b": LAG_RIG_SPEED }),
        node("offset", "vector.make3", 520, { "default:y": 0, "default:z": 0 }),
        node("slide", "transform.addWorldOffset", 780),
      ] : []),
    ],
    edges: [
      wire("began", "execOut", "project", "execIn"),
      wire("project", "execOut", "log", "execIn"),
      wire("began", "finger", "project", "finger"),
      wire("project", "actor", "name", "target"),
      wire("project", "hit", "text", "arg:hit"),
      wire("name", "out", "text", "arg:actor"),
      wire("project", "worldOrigin", "text", "arg:origin"),
      wire("project", "worldDirection", "text", "arg:direction"),
      wire("where", "out", "text", "arg:box"),
      wire("text", "out", "log", "message"),
      ...(moving ? [
        wire("tick", "execOut", "slide", "execIn"),
        wire("tick", "deltaSeconds", "step", "a"),
        wire("step", "out", "offset", "x"),
        wire("offset", "out", "slide", "offset"),
      ] : []),
    ],
    members: [],
    components,
  } as unknown as SerializedGraph;
}

/**
 * A project whose Main Scene holds a red, unlit, colliding box and a camera. `plain` puts the Camera component on the
 * camera actor itself; `arm` puts it on a 9 m Spring Arm pitched down 18 degrees, as the Feature Test tour camera's;
 * `lag` gives that arm Location Lag and parents the camera to the box, which slides steadily along +X, so the camera
 * Play draws trails where the arm would hold it, as the touring camera's does, while the box keeps still on screen.
 */
async function traceProject(rig: Rig): Promise<Map<string, Uint8Array>> {
  const files = await minimalProjectFiles();
  const material = createDefaultMaterialDocument("Red");
  material.shadingModel = "unlit";
  material.nodes.find((entry) => entry.id === "baseColor")!.properties.value = [1, 0, 0];
  files.set("assets/Red.material.hasset", await encodeAssetDocument({
    guid: RED_GUID, type: "Material", name: "Red", version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
  }));
  const redBox = (id: string) => {
    const mesh = createMeshComponent(id, "box", "simple");
    mesh.properties = { ...mesh.properties, materialGuid: RED_GUID };
    return mesh;
  };
  const classFile = files.get(MAIN_CLASS_FILE)!;
  const classDocument = await decodeAssetDocument(classFile);
  files.set(MAIN_CLASS_FILE, await encodeAssetDocument(
    { ...classDocument, payload: traceGraph([redBox("prefab-mesh")], rig === "lag") as unknown as Record<string, unknown> },
    { parentClass: "Actor", dependencies: [RED_GUID] },
  ));
  const sceneFile = files.get(MAIN_SCENE_FILE)!;
  const decoded = await decodeAssetDocument(sceneFile);
  const scene = decoded.payload as unknown as SerializedScene;
  // Nothing but the box and the camera: no sky or sun to tint the red.
  const box = scene.actors.find((actor) => actor.id === "actor-1")!;
  box.transform = { ...identitySerializedTransform(), position: [TARGET.x, TARGET.y, TARGET.z] };
  box.components = [{ ...redBox("mesh-1"), sourceId: "prefab-mesh" }];
  const camera = scene.actors.find((actor) => actor.id === scene.settings.defaultCameraActorId)!;
  const lens = camera.components.find((component) => component.classId === "CameraComponent")!;
  lens.properties = { ...lens.properties, projectionMode: "perspective", fieldOfView: 60, nearClip: 0.1, farClip: 200 };
  if (rig === "plain") {
    camera.transform = { ...identitySerializedTransform(), position: [0, 2, -6] };
    lens.transform = identitySerializedTransform();
    lens.parentId = null;
    camera.components = [lens];
  } else {
    // The pivot sits low and close; the arm swings the lens 9 m back and up, looking down 18 degrees.
    const pivot: [number, number, number] = [0, 0.5, 0];
    camera.transform = rig === "lag"
      ? { ...identitySerializedTransform(), position: [pivot[0] - TARGET.x, pivot[1] - TARGET.y, pivot[2] - TARGET.z] }
      : { ...identitySerializedTransform(), position: pivot };
    if (rig === "lag") camera.parentId = box.id;
    const arm: SerializedComponent = {
      id: "trace-arm", classId: "SpringArmComponent", parentId: null,
      properties: { ...parseSpringArmProperties({ armLength: 9, enableLocationLag: rig === "lag", locationLagSpeed: 0.5 }) },
      transform: { ...identitySerializedTransform(), rotation: [HALF_PITCH.s, 0, 0, HALF_PITCH.c] },
    };
    camera.components = [arm, { ...lens, parentId: "trace-arm", transform: identitySerializedTransform() }];
  }
  scene.actors = [box, camera];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument(
    { ...decoded, payload: scene as unknown as Record<string, unknown> },
    { dependencies: [...readHassetHeader(sceneFile).dependencies, RED_GUID] },
  ));
  return files;
}

/** The red box's centre on `canvas`, as a fraction of its width and height, read from the canvas's own pixels. */
async function redCentroid(canvas: Locator): Promise<{ x: number; y: number; pixels: number } | null> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    // Read a copy: reading the view canvas itself would change how the browser backs it.
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(node, 0, 0);
    const data = context.getImageData(0, 0, copy.width, copy.height).data;
    let sumX = 0, sumY = 0, count = 0;
    for (let y = 0; y < copy.height; y++) {
      for (let x = 0; x < copy.width; x++) {
        const i = (y * copy.width + x) * 4;
        if (data[i]! - Math.max(data[i + 1]!, data[i + 2]!) > 120) { sumX += x + 0.5; sumY += y + 0.5; count++; }
      }
    }
    return count === 0 ? null : { x: sumX / count / copy.width, y: sumY / count / copy.height, pixels: count };
  });
}

/**
 * Waits for a still picture (a lagging camera has settled into its steady trail behind the sliding box), then taps or
 * clicks the middle of the red box where `canvas` shows it.
 */
async function touchRedBox(page: Page, canvas: Locator, touch: boolean): Promise<void> {
  let target: Awaited<ReturnType<typeof redCentroid>> = null;
  const box = async () => (await canvas.boundingBox())!;
  await expect.poll(async () => {
    const { width, height } = await box();
    const before = await redCentroid(canvas);
    await page.waitForTimeout(500);
    target = await redCentroid(canvas);
    if (!before || !target || target.pixels < 50) return Number.POSITIVE_INFINITY;
    return Math.hypot((target.x - before.x) * width, (target.y - before.y) * height);
  }, { timeout: 60_000 }).toBeLessThan(1);
  // In page pixels, from wherever the canvas sits on the page (inside the Preview Build frame too).
  const { x, y, width, height } = await box();
  const at = { x: x + target!.x * width, y: y + target!.y * height };
  if (touch) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
}

function parseVector(text: string): Vec3 {
  const [x, y, z] = (text.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
  return { x: x!, y: y!, z: z! };
}

function parseTraces(messages: readonly string[]): TraceReport[] {
  return messages.flatMap((message) => {
    const match = /TRACE ([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/.exec(message);
    if (!match) return [];
    return [{
      hit: match[1]!.trim() === "true", actor: match[2]!.trim(),
      origin: parseVector(match[3]!), direction: parseVector(match[4]!), box: parseVector(match[5]!),
    }];
  });
}

/** How far the ray passes from the box's centre where the game had it when the touch traced, in metres. */
function missDistance(report: TraceReport): number {
  const d = report.direction;
  const length = Math.hypot(d.x, d.y, d.z) || 1;
  const v = { x: report.box.x - report.origin.x, y: report.box.y - report.origin.y, z: report.box.z - report.origin.z };
  const along = (v.x * d.x + v.y * d.y + v.z * d.z) / length;
  return Math.sqrt(Math.max(0, v.x * v.x + v.y * v.y + v.z * v.z - along * along));
}

/** The touch hit the box, through its middle: well inside its half-metre faces. */
function expectHitThroughBox(reports: TraceReport[]): void {
  const [report] = reports;
  const missed = missDistance(report!);
  expect(report, `ray ${JSON.stringify(report)} passes ${missed.toFixed(3)} m from the box`).toMatchObject({ hit: true, actor: "Actor" });
  expect(missed).toBeLessThan(0.25);
}

for (const rig of ["plain", "arm", "lag"] as const) {
  test(`a touch traces into the Scene where it lands on the Play view (${rig} camera)`, { tag: IPAD_TEST_TAG }, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await openMinimalTestProject(page, await traceProject(rig));
    await openMainScene(page);
    await clickPlayAndWaitForOverlay(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as PlayHost).__hapticPlayTest.tickIndex()), { timeout: 60_000 }).toBeGreaterThan(30);
    await touchRedBox(page, page.getByTestId("play-canvas"), testInfo.project.use.hasTouch === true);
    const traces = async () => parseTraces((await page.evaluate(() => (window as unknown as PlayHost).__hapticPlayTest.problemLogs())).map((log) => log.message));
    await expect.poll(async () => (await traces()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    expectHitThroughBox(await traces());
  });
}

test("a click traces into the Scene where it lands in a Simulation's view inside the viewport, through a lagging camera", async ({ page }) => {
  test.setTimeout(180_000);
  await openMinimalTestProject(page, await traceProject("lag"));
  await openMainScene(page);
  await page.evaluate(() => (window as unknown as { __hapticSimulationTest: { start(): void } }).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as PlayHost).__hapticPlayTest.tickIndex()), { timeout: 60_000 }).toBeGreaterThan(30);
  // The Simulation's view is smaller than the page and set into it, away from its top-left corner.
  const canvas = page.getByTestId("play-canvas");
  const placed = (await canvas.boundingBox())!;
  expect(placed.x > 0 && placed.y > 0).toBe(true);
  await touchRedBox(page, canvas, false);
  const traces = async () => parseTraces((await page.evaluate(() => (window as unknown as PlayHost).__hapticPlayTest.problemLogs())).map((log) => log.message));
  await expect.poll(async () => (await traces()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  expectHitThroughBox(await traces());
});

test("a click traces into the Scene where it lands in Preview Build, through a lagging camera", async ({ page }) => {
  test.setTimeout(240_000);
  await openMinimalTestProject(page, await traceProject("lag"));
  await openMainScene(page);
  // The player mirrors the game's log lines to the editor page.
  await page.evaluate((type) => {
    const host = window as unknown as { __traceLogs: string[] };
    host.__traceLogs = [];
    window.addEventListener("message", (event: MessageEvent) => {
      const command = (event.data as { type?: string; command?: { type?: string; message?: unknown } } | null);
      if (command?.type === type && command.command?.type === "log" && typeof command.command.message === "string") host.__traceLogs.push(command.command.message);
    });
  }, PREVIEW_CONSOLE_EVENT_MESSAGE);
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  await touchRedBox(page, page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas"), false);
  const traces = async () => parseTraces(await page.evaluate(() => (window as unknown as { __traceLogs: string[] }).__traceLogs));
  await expect.poll(async () => (await traces()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  expectHitThroughBox(await traces());
  await page.getByTestId("preview-build-close").click();
});
