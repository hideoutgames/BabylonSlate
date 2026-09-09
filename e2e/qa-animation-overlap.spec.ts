import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  decodeAssetDocument,
  encodeAssetDocument,
} from "../packages/assets/src/asset-document";
import type { AnimGraphDocument } from "../packages/anim-graph/src/graph";
import {
  createActor,
  identitySerializedTransform,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

const CLASS_PATH = "assets/Mannequin.class.babasset";
const ANIM_PATH = "assets/Mannequin/Mannequin.anim.babasset";

type TestHost = {
  __babylonslateTest: {
    readAssetChunk(path: string, chunk: string): Promise<Uint8Array>;
    setMainGraphContent(graph: SerializedGraph): Promise<boolean>;
    setActiveSceneContent(scene: SerializedScene): Promise<boolean>;
  };
  __babylonslatePlayTest: { whenModelsReady(): Promise<void> };
};

async function documentPayload<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (assetPath) => {
    const bytes = await (
      globalThis as unknown as TestHost
    ).__babylonslateTest.readAssetChunk(assetPath, "document");
    return JSON.parse(new TextDecoder().decode(bytes));
  }, path);
}

async function assetBytes(page: Page, path: string): Promise<Uint8Array> {
  return new Uint8Array(
    await page.evaluate(async (assetPath) => {
      let folder = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("opfs:TestProject");
      const parts = assetPath.split("/");
      for (const part of parts.slice(0, -1))
        folder = await folder.getDirectoryHandle(part);
      return Array.from(
        new Uint8Array(
          await (
            await (await folder.getFileHandle(parts.at(-1)!)).getFile()
          ).arrayBuffer(),
        ),
      );
    }, path),
  );
}

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): SerializedGraph["nodes"][number] {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function edge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): SerializedGraph["edges"][number] {
  return {
    id: `${source}-${sourceHandle}-${target}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

/** Only tan Mannequin pixels: chrome, Print text, and frame counters cannot change the signature. */
async function mannequinPixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = element.width;
    copy.height = element.height;
    const context = copy.getContext("2d");
    if (!context) return { pixels: 0, signature: 0 };
    context.drawImage(element, 0, 0);
    const { data } = context.getImageData(0, 0, element.width, element.height);
    let pixels = 0;
    let signature = 2166136261;
    for (let offset = 0; offset < data.length; offset += 4) {
      const [r, g, b] = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
      if (r > 70 && g > 30 && r > g * 1.12 && g > b * 1.1) {
        pixels++;
        signature = Math.imul(signature ^ offset, 16777619) >>> 0;
      }
    }
    return { pixels, signature };
  });
}

test("H16: Space jumps the wired Mannequin graph to a visible Walk pose and returns to Idle", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  const animationAsset = await decodeAssetDocument(
    await assetBytes(page, ANIM_PATH),
  );
  const animation = animationAsset.payload as unknown as AnimGraphDocument;
  const walkPath = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("opfs:TestProject");
    const folder = await (
      await project.getDirectoryHandle("assets")
    ).getDirectoryHandle("Mannequin");
    for await (const name of folder.keys()) {
      if (/(?:^|_)walk(?:[._]|$)/i.test(name) && name.endsWith(".babasset"))
        return `assets/Mannequin/${name}`;
    }
    throw new Error("Imported Mannequin Walk Animation is missing");
  });
  const walk = await decodeAssetDocument(await assetBytes(page, walkPath));
  expect(walk.type).toBe("Animation");
  animation.states[0]!.speed = 0;
  animation.states.push({
    id: "walk",
    name: "Walk",
    clipId: "walk",
    speed: 1,
    loop: true,
    position: { x: 300, y: 0 },
  });
  animation.clips.push({
    id: "walk",
    kind: "animation",
    assetGuid: walk.guid,
    clipName: "walk",
    durationMs: Number(walk.payload.durationMs),
  });
  const encoded = await encodeAssetDocument(animationAsset, {
    dependencies: animation.clips.map((clip) => clip.assetGuid),
  });
  await page.evaluate(
    async ({ path, bytes }) => {
      let folder = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("opfs:TestProject");
      const parts = path.split("/");
      for (const part of parts.slice(0, -1))
        folder = await folder.getDirectoryHandle(part);
      const writer = await (
        await folder.getFileHandle(parts.at(-1)!)
      ).createWritable();
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    },
    { path: ANIM_PATH, bytes: Array.from(encoded) },
  );
  await page.reload();
  await openTestProject(page);
  const graph = await documentPayload<SerializedGraph>(page, CLASS_PATH);
  graph.nodes = [
    node("space", "input.onAction", { action: "Jump", phase: "pressed" }),
    node("walk", "anim.actor.jumpToState", { state: "Walk" }),
    node("confirm", "input.onAction", { action: "Confirm", phase: "pressed" }),
    node("idle", "anim.actor.jumpToState", { state: "Idle" }),
    node("graph", "component.getNamed", {
      componentClassId: "AnimationGraphComponent",
      implicitSelf: true,
    }),
    node("tick", "flow.event.tick"),
    node("state", "anim.actor.getCurrentState"),
    node("print", "debug.print", {
      key: "anim-state",
      duration: 30,
      developmentOnly: false,
    }),
  ];
  graph.edges = [
    edge("space", "execOut", "walk", "execIn"),
    edge("confirm", "execOut", "idle", "execIn"),
    ...["walk", "idle", "state"].map((id) =>
      edge("graph", "out", id, "target"),
    ),
    edge("tick", "execOut", "print", "execIn"),
    edge("state", "name", "print", "value"),
  ];
  expect(
    await page.evaluate(
      (next) =>
        (
          globalThis as unknown as TestHost
        ).__babylonslateTest.setMainGraphContent(next),
      graph,
    ),
  ).toBe(true);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await page.evaluate(() =>
    (
      globalThis as unknown as TestHost
    ).__babylonslatePlayTest.whenModelsReady(),
  );
  const canvas = page.getByTestId("play-canvas");
  const prints = page.getByTestId("print-overlay");
  await expect(prints).toContainText("Idle");
  await expect
    .poll(async () => (await mannequinPixels(canvas)).pixels)
    .toBeGreaterThan(50);
  const idle = await mannequinPixels(canvas);
  await canvas.screenshot({ path: testInfo.outputPath("h16-idle.png") });
  await canvas.click();
  await page.keyboard.press("Space");
  await expect(prints).toContainText("Walk");
  await expect.poll(async () => {
    const walk = await mannequinPixels(canvas);
    return walk.pixels > 50 && walk.signature !== idle.signature;
  }).toBe(true);
  await canvas.screenshot({ path: testInfo.outputPath("h16-walk.png") });
  await page.keyboard.press("Enter");
  await expect(prints).toContainText("Idle");
  await expect.poll(() => mannequinPixels(canvas)).toEqual(idle);
  await canvas.screenshot({ path: testInfo.outputPath("h16-return-idle.png") });
  await page.getByTestId("play-overlay-close").click();
});

test("D800: the authored trigger receives Begin Overlap when it is the second collider", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  const graph = await documentPayload<SerializedGraph>(page, CLASS_PATH);
  await openMainScene(page);
  const scene = await documentPayload<SerializedScene>(
    page,
    "assets/main.scene.babasset",
  );
  const mannequin = scene.actors.find(
    (actor) => actor.classId === "Mannequin",
  )!;
  expect(mannequin).toBeTruthy();
  const triggerComponents: SerializedComponent[] = [
    {
      id: "body",
      classId: "RigidBodyComponent",
      properties: { motionType: "static", mass: 0, gravityScale: 0 },
    },
    {
      id: "blocking",
      classId: "ColliderComponent",
      properties: {
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      },
      transform: { ...identitySerializedTransform(), position: [0, 10, 0] },
    },
    {
      id: "trigger",
      classId: "ColliderComponent",
      properties: {
        isTrigger: true,
        shape: { kind: "box", halfExtents: { x: 2, y: 2, z: 2 } },
      },
    },
  ];
  graph.components = triggerComponents;
  graph.nodes = [
    node("overlap", "flow.event.beginOverlap", { componentId: "trigger" }),
    node("print", "debug.print", {
      value: "OVERLAP",
      key: "overlap",
      duration: 30,
      developmentOnly: false,
    }),
  ];
  graph.edges = [edge("overlap", "execOut", "print", "execIn")];
  expect(
    await page.evaluate(
      (next) =>
        (
          globalThis as unknown as TestHost
        ).__babylonslateTest.setMainGraphContent(next),
      graph,
    ),
  ).toBe(true);
  const dynamic = createActor("qa-dynamic", "Dynamic Mannequin", {
    components: [
      mannequin.components.find(
        (component) => component.classId === "MeshComponent",
      )!,
      {
        id: "dynamic-body",
        classId: "RigidBodyComponent",
        properties: { motionType: "dynamic", mass: 1, gravityScale: 0 },
      },
      {
        id: "dynamic-collider",
        classId: "ColliderComponent",
        properties: {
          shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        },
      },
    ],
  });
  dynamic.transform.position = [0, 2, 0];
  const trigger = createActor("qa-trigger", "TriggerVolume", {
    classId: "Mannequin",
    components: triggerComponents,
  });
  trigger.transform.position = [0, 2, 0];
  scene.actors = [
    ...scene.actors.filter((actor) => actor.id !== mannequin.id),
    dynamic,
    trigger,
  ];
  expect(
    await page.evaluate(
      (next) =>
        (
          globalThis as unknown as TestHost
        ).__babylonslateTest.setActiveSceneContent(next),
      scene,
    ),
  ).toBe(true);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText("OVERLAP", {
    timeout: 30_000,
  });
  await page.evaluate(() =>
    (
      globalThis as unknown as TestHost
    ).__babylonslatePlayTest.whenModelsReady(),
  );
  await page
    .getByTestId("play-overlay")
    .screenshot({ path: testInfo.outputPath("d800-trigger-overlap.png") });
  await page.getByTestId("play-overlay-close").click();
});
