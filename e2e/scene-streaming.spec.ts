import { expect, test, type Locator } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createSceneStreamingActor,
  identitySerializedTransform,
  MAIN_SCENE_FILE,
  type SerializedGraph,
} from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const MAIN_GUID = "00000000-0000-4000-8000-000000000001";
const CHILD_GUID = "20000000-0000-4000-8000-000000000001";
const PARENT_POSITION = [0, -2, 0];
const LEFT_POSITIONS = [[-2.5, 0, 0], [-2.5, 2, 0]];
const RIGHT_POSITIONS = [[5.5, 0, 0], [5.5, 2, 0]];

function commandGraph(commandName: string, actorClass: string, method: string): SerializedGraph {
  return {
    nodes: [
      { id: "run", type: "flow.event.commandRun", data: { commandName }, position: { x: 0, y: 0 } },
      { id: "target", type: "actor.getOfClass", data: { "default:classId": actorClass }, position: { x: 0, y: 200 } },
      { id: "cast", type: "casting.cast", data: { "default:class": "SceneStreamingActor", defaultClassId: "SceneStreamingActor", resultKind: "actorRef" }, position: { x: 250, y: 0 } },
      { id: "stream", type: `sceneStreaming.${method}`, data: {}, position: { x: 500, y: 0 } },
    ],
    edges: [
      { id: "run-cast", source: "run", sourceHandle: "execOut", target: "cast", targetHandle: "execIn" },
      { id: "target-cast", source: "target", sourceHandle: "out", target: "cast", targetHandle: "object" },
      { id: "cast-stream", source: "cast", sourceHandle: "execOut", target: "stream", targetHandle: "execIn" },
      { id: "typed-target", source: "cast", sourceHandle: "result", target: "stream", targetHandle: "target" },
    ],
  };
}

async function streamingProject() {
  const files = await minimalProjectFiles();
  const versions = createDefaultMigrationRegistry();
  // Empty graphs have no script bundle, so give the fixture subclasses an entry point.
  const streamingActorGraph = (commands: string[]): SerializedGraph => ({
    nodes: [{ id: "begin", type: "flow.event.beginPlay", data: {}, position: { x: 0, y: 0 } }],
    edges: [],
    components: [],
    // Authored references keep the test controls reachable when Preview saves the Scene.
    members: commands.map((command) => ({
      id: command, kind: "variable", name: command,
      typeId: "class", typeClassId: "BDebugCommand", defaultValue: command,
    })),
  });
  const classes: Array<[string, string, SerializedGraph]> = [
    ["LeftStreaming", "SceneStreamingActor", streamingActorGraph(["LoadLeft", "UnloadLeft"])],
    ["RightStreaming", "SceneStreamingActor", streamingActorGraph(["LoadRight", "UnloadRight"])],
    ["LoadLeft", "BDebugCommand", commandGraph("stream_left_load", "LeftStreaming", "loadSceneBlocking")],
    ["LoadRight", "BDebugCommand", commandGraph("stream_right_load", "RightStreaming", "loadSceneAsync")],
    ["UnloadLeft", "BDebugCommand", commandGraph("stream_left_unload", "LeftStreaming", "unloadSceneAsync")],
    ["UnloadRight", "BDebugCommand", commandGraph("stream_right_unload", "RightStreaming", "unloadSceneBlocking")],
  ];
  for (const [index, [name, parentClass, graph]] of classes.entries()) {
    const guid = `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    files.set(`assets/${name}.class.babasset`, await encodeAssetDocument({
      guid, type: "Class", name, version: versions.currentVersion("Class"),
      payload: graph as unknown as Record<string, unknown>,
    }, { parentClass }));
  }
  const child = createDefaultScene();
  child.name = "Streamed Room";
  child.actors = [
    createActor("room", "Room", {
      transform: { ...identitySerializedTransform(), position: [1, 0, 0] },
      components: [createMeshComponent("room-mesh", "box")],
    }),
    createActor("room-child", "Room Child", {
      parentId: "room",
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [createMeshComponent("room-child-mesh", "box")],
    }),
  ];
  files.set("assets/StreamedRoom.scene.babasset", await encodeAssetDocument({
    guid: CHILD_GUID, type: "Scene", name: child.name,
    version: versions.currentVersion("Scene"), payload: child as unknown as Record<string, unknown>,
  }));

  const scene = createDefaultScene();
  scene.settings.environmentTextureGuid = null;
  scene.settings.shadowOverrides = { enabled: false };
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
  scene.actors[0]!.transform = { ...identitySerializedTransform(), position: [1.5, 1, -15] };
  scene.actors.push(createActor("parent-box", "Parent Box", {
    transform: { ...identitySerializedTransform(), position: [0, -2, 0] },
    components: [createMeshComponent("parent-mesh", "box")],
  }));
  scene.actors.push(createActor("fill", "Fill", {
    components: [{ id: "fill-light", classId: "HemisphericFillLightComponent", properties: { intensity: 1, color: [1, 1, 1], groundColor: [1, 1, 1] } }],
  }));
  for (const [id, classId, x] of [["left", "LeftStreaming", -4], ["right", "RightStreaming", 4]] as const) {
    const actor = createSceneStreamingActor(id, CHILD_GUID, child.name, { ...identitySerializedTransform(), position: [x, 0, 0] });
    actor.classId = classId;
    actor.components[0]!.transform!.position = [0.5, 0, 0];
    scene.actors.push(actor);
  }
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: MAIN_GUID, type: "Scene", name: "Main", version: versions.currentVersion("Scene"),
    payload: scene as unknown as Record<string, unknown>,
  }));
  return files;
}

async function visiblePositions(host: Locator) {
  return host.evaluate(() => {
    type VisualHost = { visuals: () => Array<{ visible: boolean; position: number[] }> };
    const global = globalThis as unknown as { __babylonslatePlayTest?: VisualHost; __babylonslatePlayerTest?: VisualHost };
    return (global.__babylonslatePlayTest ?? global.__babylonslatePlayerTest)?.visuals()
      .filter((visual) => visual.visible)
      .map((visual) => visual.position.map((value) => Math.round(value * 1000) / 1000))
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!) ?? [];
  });
}

for (const mode of ["Play", "Preview Build"] as const) {
  test(`${mode} streams two scene instances at their component origins and unloads them independently`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openMinimalTestProject(page, await streamingProject());
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    const editorActors = await page.evaluate(() => (globalThis as unknown as {
      __babylonslateViewportTest: { sceneVisuals: () => Array<{ actorId: string }> };
    }).__babylonslateViewportTest.sceneVisuals().map((visual) => visual.actorId));
    expect(editorActors).toEqual(expect.arrayContaining(["parent-box", "left", "right"]));
    expect(editorActors.some((id) => id === "room" || id === "room-child" || id.startsWith("scene-stream:"))).toBe(false);

    if (mode === "Preview Build") {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
      await page.getByRole("button", { name: "Console", exact: true }).click();
    } else {
      await clickPlayAndWaitForOverlay(page);
      await page.getByTestId("play-console-open").click();
    }
    const host = mode === "Play" ? page.getByTestId("play-overlay") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-root");
    const run = async (command: string) => {
      await page.getByTestId("debug-console-input").fill(command);
      await page.getByTestId("debug-console-submit").click();
    };
    const positions = async (expected: number[][]) => expect.poll(() => visiblePositions(host), { timeout: 30_000 }).toEqual(expected);
    const sceneSources = async () => page.evaluate((guid) => {
      const testHost = (globalThis as unknown as { __babylonslateTest: {
        assetLoading: () => { sources: { entries: Array<{ assetId: string; owners: string[] }> } };
        trimAssetSources: () => void;
      } }).__babylonslateTest;
      testHost.trimAssetSources();
      return testHost.assetLoading().sources.entries.filter((entry) => entry.assetId === guid);
    }, CHILD_GUID);
    const sceneDocumentReads = async () => page.evaluate(() => {
      const testHost = (globalThis as unknown as { __babylonslateTest: {
        assetLoading: () => { chunks: { recentRequests: Array<{ path: string; chunkId: string }> } };
      } }).__babylonslateTest;
      return testHost.assetLoading().chunks.recentRequests.filter((entry) =>
        entry.path === "assets/StreamedRoom.scene.babasset" && entry.chunkId === "document").length;
    });
    await positions([PARENT_POSITION]);
    if (mode === "Play") {
      expect(await sceneSources()).toEqual([]);
      expect(await sceneDocumentReads()).toBe(0);
    }
    await run("stream_left_load");
    await positions([...LEFT_POSITIONS, PARENT_POSITION]);
    await run("stream_right_load");
    await positions([...LEFT_POSITIONS, PARENT_POSITION, ...RIGHT_POSITIONS]);
    if (mode === "Play") expect(await sceneDocumentReads()).toBe(1);
    await run("stream_left_unload");
    await positions([PARENT_POSITION, ...RIGHT_POSITIONS]);
    if (mode === "Play") expect((await sceneSources()).some((entry) => entry.owners.length > 0)).toBe(true);
    await run("stream_left_load");
    await positions([...LEFT_POSITIONS, PARENT_POSITION, ...RIGHT_POSITIONS]);
    await run("stream_right_unload");
    await positions([...LEFT_POSITIONS, PARENT_POSITION]);
    await run("stream_left_unload");
    await positions([PARENT_POSITION]);
    if (mode === "Play") await expect.poll(sceneSources).toEqual([]);
    expect(errors).toEqual([]);
    await page.getByTestId(mode === "Play" ? "play-overlay-close" : "preview-build-close").click();
  });
}
