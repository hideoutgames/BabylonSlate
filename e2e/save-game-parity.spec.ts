import { expect, test, type Page } from "@playwright/test";
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
if (loaded.ok && loaded.value.recovered) {
  ctx.print("Recovered Sequence: " + loaded.value.sequence, "recovery", 60, { x: 1, y: 1, z: 1, w: 1 });
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

/** Inspect only this fixture's known slot through public OPFS APIs. */
async function savedGenerations(page: Page, projectId: string, corruptNewest = false) {
  return page.evaluate(async ({ projectId, corruptNewest }) => {
    const encode = (part: string) => `k${Array.from(new TextEncoder().encode(part), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    let directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("babylonslate-game-saves");
    for (const part of ["save-games", encodeURIComponent(projectId), "game", "default", "default"]) {
      directory = await directory.getDirectoryHandle(encode(part));
    }
    const generations = await Promise.all(["generation-a.save", "generation-b.save"].map(async name => {
      const text = await (await (await directory.getFileHandle(encode(name))).getFile()).text();
      const envelope = JSON.parse(text) as { checksum: string; payload: string };
      const body = JSON.parse(envelope.payload) as { sequence: number; fields: Record<string, number> };
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(envelope.payload));
      const checksum = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
      return { name, text, sequence: body.sequence, visits: body.fields["visits-id"], checksumValid: envelope.checksum === checksum };
    }));
    generations.sort((left, right) => left.sequence - right.sequence);
    if (corruptNewest) {
      const newest = generations[1]!;
      const envelope = JSON.parse(newest.text) as { checksum: string; payload: string };
      envelope.checksum = (envelope.checksum[0] === "0" ? "1" : "0") + envelope.checksum.slice(1);
      const writer = await (await directory.getFileHandle(encode(newest.name))).createWritable();
      try { await writer.write(JSON.stringify(envelope)); await writer.close(); }
      catch (error) { await writer.abort().catch(() => {}); throw error; }
    }
    return generations;
  }, { projectId, corruptNewest });
}

async function verifyCrossTabRecovery(page: Page, url: string, projectId: string) {
  const lockName = `babylonslate:game-saves:save-games/${encodeURIComponent(projectId)}/game`;
  // Queue both real browser contexts behind the same public Web Lock before releasing them.
  await page.evaluate(name => new Promise<void>((held, reject) => {
    void navigator.locks.request(name, { mode: "exclusive" }, () => new Promise<void>(release => {
      window.addEventListener("save-parity-release-lock", () => release(), { once: true });
      held();
    })).catch(reject);
  }), lockName);
  const tabs = await Promise.all([page.context().newPage(), page.context().newPage()]);
  const releaseGate = () => page.evaluate(() => window.dispatchEvent(new Event("save-parity-release-lock")));
  try {
    await Promise.all(tabs.map(tab => tab.goto(url)));
    await expect.poll(() => page.evaluate(async name => {
      const locks = await navigator.locks.query();
      return locks.pending?.filter(lock => lock.name === name).length ?? 0;
    }, lockName), { timeout: 40_000 }).toBeGreaterThanOrEqual(2);
    await releaseGate();
    // Load and Save are distinct operations: gameplay counters may race, commit sequences may not.
    await Promise.all(tabs.map(tab => expect(tab.getByTestId("print-overlay"))
      .toContainText(/Saved Visits: [34]\b/, { timeout: 40_000 })));
  } finally {
    await releaseGate();
    await Promise.all(tabs.map(tab => tab.close()));
  }
  const before = await savedGenerations(page, projectId);
  expect(before.map(generation => generation.sequence)).toEqual([3, 4]);
  expect(before.every(generation => generation.checksumValid)).toBe(true);
  const previous = before[0]!;
  const newest = before[1]!;
  await savedGenerations(page, projectId, true);
  await page.reload();
  await expect(page.getByTestId("print-overlay")).toContainText("Recovered Sequence: 3", { timeout: 40_000 });
  await expect(page.getByTestId("print-overlay")).toContainText(`Saved Visits: ${previous.visits + 1}`, { timeout: 40_000 });
  const recovered = await savedGenerations(page, projectId);
  expect(recovered.map(generation => generation.sequence)).toEqual([3, 4]);
  expect(recovered.find(generation => generation.name === previous.name)?.text).toBe(previous.text);
  expect(recovered.find(generation => generation.name === newest.name))
    .toMatchObject({ sequence: 4, visits: previous.visits + 1, checksumValid: true });
}

for (const mode of ["packed"] as ("packed" | "loose")[]) {
  test(`${mode} exported game restores OPFS progress after a cold page reload`, async ({ page, baseURL }, info) => {
    test.setTimeout(mode === "packed" ? 240_000 : 120_000);
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
      if (mode === "packed") {
        await verifyCrossTabRecovery(page, server.url, "export-packed");
        await page.screenshot({ path: info.outputPath("packed-cross-tab-recovery.png") });
      }
    } finally { await server.close(); }
  });
}
