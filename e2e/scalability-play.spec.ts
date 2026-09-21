import { expect, test, type Page } from "@playwright/test";
import { MAIN_CLASS_FILE, MAIN_SCENE_FILE, PROJECT_FILE, createActor, createDefaultScene, createMeshComponent, normalizeRenderProjectSettings, type ProjectDocument, type SerializedGraph } from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import type { EngineHandle } from "../packages/render/src/create-engine";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { scalabilityGraphDefinitions } from "./scalability-graph-fixture";
import { renderingEvidence } from "./rendering-evidence";

type PlayTest = {
  rendering(): ReturnType<EngineHandle["renderDiagnostics"]> | null;
  scalability(): ReturnType<EngineHandle["scalabilityStatus"]>;
  renderTasks(): string[];
};
const read = (page: Page) => page.evaluate(() => {
  const host = (window as unknown as { __babylonslatePlayTest: PlayTest }).__babylonslatePlayTest;
  return { rendering: host.rendering(), scalability: host.scalability(), tasks: host.renderTasks() };
});

test("saved Class scalability graphs compile and run with confirmed events in editor Play", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!)) as ProjectDocument;
  project.settings.render = normalizeRenderProjectSettings({ gpuBackend: "webgl2", renderPath: "forward", mode: "cel", effects: { fxaa: true }, shadows: { enabled: false }, quality: { resolution: { dynamic: false, scale: 0.8, minScale: 0.8 } }, customResolution: true, width: 480, height: 270, blackBars: true });
  project.settings.playFrameCap = 30;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const version = createDefaultMigrationRegistry().currentVersion("Class");
  const scene = createDefaultScene();
  scene.actors = [createActor("observer", "Settings Observer", { classId: "main", components: [createMeshComponent("mesh", "box")] }), ...scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId)];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", version: createDefaultMigrationRegistry().currentVersion("Scene"), payload: scene as unknown as Record<string, unknown> }, { dependencies: ["00000000-0000-4000-8000-000000000002"] }));
  for (const [index, { name, graph }] of scalabilityGraphDefinitions().entries()) {
    const document: SerializedGraph = {
      nodes: graph.nodes.map((node) => ({ id: node.id, type: node.typeId, data: node.properties, position: node.position })),
      edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, sourceHandle: edge.sourcePinId, target: edge.targetNodeId, targetHandle: edge.targetPinId })),
    };
    files.set(`assets/${name}.class.babasset`, await encodeAssetDocument({ guid: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, type: "Class", name, version, payload: document as unknown as Record<string, unknown> }, { parentClass: "BDebugCommand" }));
  }
  // A real actor receives asynchronous renderer acknowledgements. Both the
  // event payload and Get Effective Scalability execute in the authored graph.
  const observer: SerializedGraph = {
    nodes: [
      { id: "changed", type: "flow.event.scalabilityChanged", data: {}, position: { x: 0, y: 0 } },
      { id: "read", type: "scalability.getEffective", data: {}, position: { x: 0, y: 150 } },
      ...["payload", "readback"].flatMap((id, index) => [
        { id: `${id}-break`, type: "struct.break", data: { structGuid: "engine:ScalabilitySnapshot", fields: [{ name: "appliedRevision", typeId: "float" }] }, position: { x: 200, y: 150 + index * 150 } },
        { id: `${id}-text`, type: "literal.toStringFloat", data: {}, position: { x: 400, y: 150 + index * 150 } },
      ]),
      { id: "log", type: "debug.log", data: {}, position: { x: 300, y: 0 } },
      { id: "logRead", type: "debug.log", data: {}, position: { x: 600, y: 0 } },
    ], edges: [
      { id: "event", source: "changed", sourceHandle: "execOut", target: "log", targetHandle: "execIn" },
      { id: "payload", source: "changed", sourceHandle: "settings", target: "payload-break", targetHandle: "in" },
      { id: "then", source: "log", sourceHandle: "execOut", target: "logRead", targetHandle: "execIn" },
      { id: "readback", source: "read", sourceHandle: "settings", target: "readback-break", targetHandle: "in" },
      ...["payload", "readback"].flatMap((id) => [
        { id: `${id}-value`, source: `${id}-break`, sourceHandle: "appliedRevision", target: `${id}-text`, targetHandle: "in" },
        { id: `${id}-log`, source: `${id}-text`, sourceHandle: "out", target: id === "payload" ? "log" : "logRead", targetHandle: "message" },
      ]),
    ],
  };
  files.set(MAIN_CLASS_FILE, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-000000000002", type: "Class", name: "Main", version, payload: observer as unknown as Record<string, unknown> }, { parentClass: "Actor" }));
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(async () => (await read(page)).scalability?.effective?.frameCap).toBe(30);
  await page.getByTestId("play-console-open").click();
  const command = async (name: string) => {
    await page.getByTestId("debug-console-input").fill(name);
    await page.getByTestId("debug-console-submit").click();
    // Successful graph commands have no output row. Each caller waits for its
    // actual renderer acknowledgement; the next submit waits for Run admission.
    await expect(page.getByTestId("debug-console-input")).toHaveValue("");
  };
  for (const preset of ["low", "medium", "high", "ultra"]) {
    await command(`qual_${preset}`);
    await expect.poll(async () => (await read(page)).scalability?.effective?.render.quality?.lighting.profile).toBe(preset);
    expect((await read(page)).scalability?.effective?.render.mode).toBe("cel");
  }
  await command("qual_settings");
  await expect.poll(async () => (await read(page)).scalability?.effective?.render.environmentLighting?.rotationYDegrees).toBe(23);
  const custom = await read(page);
  expect(custom.rendering).toMatchObject({ width: 300, height: 180 });
  expect(custom.scalability?.effective).toMatchObject({ frameCap: 24, render: { cel: { shadowBands: 6 }, quality: { lighting: { maxLocalLights: 3 }, textures: { anisotropy: 2 }, postprocessing: { resolutionScale: 0.5 } }, effects: { fxaa: false, vignette: { color: [0.2, 0.1, 0.3] } } } });
  expect(custom.tasks.some((name) => /FXAA/.test(name))).toBe(false);
  const transcript = page.getByTestId("debug-console-transcript");
  await expect(transcript.getByText(`[log] ${custom.scalability!.revision}`, { exact: true })).toHaveCount(2);
  await command("qual_invalid");
  await command("qual_aa");
  await expect.poll(async () => (await read(page)).tasks.some((name) => /FXAA/.test(name))).toBe(true);
  expect((await read(page)).scalability?.revision).toBe(custom.scalability!.revision + 1);
  await command("qual_reset");
  await expect.poll(async () => (await read(page)).scalability?.effective?.frameCap).toBe(30);
  await expect.poll(async () => (await read(page)).rendering?.width).toBe(384);
  await testInfo.attach("play-compiled-scalability", { body: JSON.stringify({ custom, reset: await read(page), evidence: renderingEvidence("e2e/scalability-play.spec.ts") }), contentType: "application/json" });
  await expect(transcript.locator('[data-severity="error"]')).toHaveCount(0);
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});
