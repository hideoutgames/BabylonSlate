import { expect, test } from "@playwright/test";
import { createDefaultScene, PROJECT_FILE, type SaveGameDefinition, type SerializedGraph } from "../packages/core/src/index";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { compileGraph } from "../packages/scripting/src/compile";
import { createDefaultNodeRegistry } from "../packages/scripting-nodes/src/index";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import { exportGame } from "../packages/exporter/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { serveExportFiles } from "./export-static-server";

const definition: SaveGameDefinition = {
  id: "save-parity-definition", schemaVersion: 1,
  fields: [{ id: "visits-id", name: "visits", type: "int", defaultValue: 0 }],
};
const graph: SerializedGraph = {
  nodes: [
    { id: "loaded", type: "flow.event.firstSceneLoaded", position: { x: 0, y: 0 }, data: {} },
    { id: "save", type: "debug.executeJavaScript", position: { x: 300, y: 0 }, data: { async: true, body: `
const loaded = await ctx.loadGame();
if (!loaded.ok && loaded.error.code !== "missing") {
  ctx.print("Save Failed: " + loaded.error.code, "save", 60, { x: 1, y: 1, z: 1, w: 1 });
  return;
}
const data = ctx.getSaveData();
data.visits += 1;
const result = await ctx.saveGame();
ctx.print(result.ok ? "Saved Visits: " + data.visits : "Save Failed: " + result.error.code, "save", 60, { x: 1, y: 1, z: 1, w: 1 });
` } },
  ],
  edges: [{ id: "load-save", source: "loaded", sourceHandle: "execOut", target: "save", targetHandle: "execIn" }],
};
const registry = createDefaultNodeRegistry();
const compiled = compileGraph({
  id: "save-flow", kind: "event",
  nodes: graph.nodes.map((node) => ({ id: node.id, typeId: node.type, position: node.position,
    properties: node.data ?? {}, pins: registry.get(node.type)!.pins(node.data ?? {}) })),
  edges: graph.edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source, sourcePinId: edge.sourceHandle!,
    targetNodeId: edge.target, targetPinId: edge.targetHandle! })),
}, { registry, assetGuid: "save-flow-class" });

test("editor Play and Preview Build share persistent preview progress", async ({ page }, info) => {
  test.setTimeout(180_000);
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.guid = "save-parity-project";
  project.settings.gameInstanceClass = "SaveFlow";
  project.settings.saveGame = { definitionGuid: "save-parity-definition", defaultSlot: "default", defaultProfile: "default", wipeOnPlay: false };
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  files.set("assets/Progress.savegame.babasset", await encodeAssetDocument({ guid: definition.id, name: "Progress", type: "SaveGame", version: 1, payload: { ...definition } }));
  files.set("assets/SaveFlow.class.babasset", await encodeAssetDocument({ guid: "save-flow-class", name: "SaveFlow", type: "Class", version: createDefaultMigrationRegistry().currentVersion("Class"), payload: { ...graph } }, { parentClass: "GameInstance" }));
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText("Saved Visits: 1", { timeout: 30_000 });
  await page.getByTestId("play-overlay-close").click();
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText("Saved Visits: 2", { timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("play-save-roundtrip.png") });
  await page.getByTestId("play-overlay-close").click();
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  await expect(page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("print-overlay")).toContainText("Saved Visits: 3", { timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("preview-save-roundtrip.png") });
  await page.getByTestId("preview-build-close").click();
});

for (const mode of ["packed", "loose"] as const) {
  test(`${mode} exported game restores OPFS progress after a cold page reload`, async ({ page, baseURL }, info) => {
    test.setTimeout(120_000);
    const scene = createDefaultScene("2d");
    const artifact = await exportGame({
      mode, bundleDebugger: true, startupSceneGuid: "start", gameInstanceClass: "SaveFlow",
      renderSettings: { customResolution: false, width: 640, height: 360, blackBars: false },
      physicsWorld: "2d",
      saveGame: { projectId: `export-${mode}`, definition, preview: false },
      scripts: [{ ...compiled, assetGuid: "save-flow-class", classId: "SaveFlow", parentClassId: "GameInstance" }],
      assets: [{ guid: "start", type: "Scene", sceneGuid: "start", encoding: "json", bytes: new TextEncoder().encode(JSON.stringify(scene)) }],
      playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL).href),
    });
    if (!artifact.ok) throw new Error(artifact.error);
    const server = await serveExportFiles(artifact.value.files, { honorRange: true });
    try {
      await page.goto(server.url);
      await expect(page.getByTestId("print-overlay")).toContainText("Saved Visits: 1", { timeout: 40_000 });
      await page.reload();
      await expect(page.getByTestId("print-overlay")).toContainText("Saved Visits: 2", { timeout: 40_000 });
      await page.screenshot({ path: info.outputPath(`${mode}-save-roundtrip.png`) });
    } finally { await server.close(); }
  });
}
