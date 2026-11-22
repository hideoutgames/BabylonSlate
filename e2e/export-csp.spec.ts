import { expect, test } from "@playwright/test";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import { createActor, createDefaultScene, createMeshComponent, DEFAULT_RENDER_PROJECT_SETTINGS, identitySerializedTransform } from "../packages/core/src/index";
import { createDefaultParticleSystemPayload } from "../packages/assets/src/particle-payload";
import { createDefaultParticleGraphDocument } from "../packages/particle-graph/src/index";
import { compileGraph } from "../packages/scripting/src/compile";
import { createDefaultNodeRegistry } from "../packages/scripting-nodes/src/index";
import { exportGame, GAME_MANIFEST_FILE } from "../packages/exporter/src/index";
import { serveExportFiles } from "./export-static-server";

/**
 * An exported game boots and runs its scripts, physics and a Particle Graph under a Content Security Policy without
 * `'unsafe-eval'` (what JIT-less WebKit also requires): compiled scripts come from the static scripts module and particle
 * updates run on the bytecode tape, so nothing evaluates text.
 */
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
const encoder = new TextEncoder();

const registry = createDefaultNodeRegistry();
const nodes = [
  { id: "loaded", typeId: "flow.event.firstSceneLoaded", properties: {} },
  // Execute JavaScript bodies are part of the compiled module, so this also proves they run without `eval`.
  { id: "probe", typeId: "debug.executeJavaScript", properties: { body: `ctx.print("CSP script ran", "csp", 600, { x: 1, y: 1, z: 1, w: 1 });` } },
];
const compiled = compileGraph({
  id: "csp-probe", kind: "event",
  nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 }, pins: registry.get(node.typeId)!.pins(node.properties) })),
  edges: [{ id: "loaded-probe", sourceNodeId: "loaded", sourcePinId: "execOut", targetNodeId: "probe", targetPinId: "execIn" }],
}, { registry, assetGuid: "csp-probe-class" });

function scene() {
  const base = createDefaultScene();
  const falling = createActor("falling", "Falling", {
    transform: { ...identitySerializedTransform(), position: [6, 8, 0] },
    components: [
      createMeshComponent("falling-mesh", "box"),
      { id: "falling-body", classId: "RigidBodyComponent", properties: { motionType: "dynamic" } },
      { id: "falling-collider", classId: "ColliderComponent", properties: {} },
    ],
  });
  const sparks = createActor("sparks", "Sparks", {
    components: [{ id: "sparks-emitter", classId: "ParticleComponent", properties: { particleSystemGuid: "csp-particles", playOnStart: true } }],
  });
  return { ...base, name: "CspProbe", actors: [...base.actors, falling, sparks] };
}

test("an exported game runs scripts, physics and particles under a CSP without unsafe-eval", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const playerFiles = await loadPlayerDistFiles(new URL("/player/", baseURL).href);
  const exported = await exportGame({
    platform: "web",
    bundleDebugger: false,
    startupSceneGuid: "csp-scene",
    gameInstanceClass: "CspProbe",
    renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS,
    scripts: [{ assetGuid: "csp-probe-class", classId: "CspProbe", parentClassId: "GameInstance", source: compiled.source,
      anchors: compiled.anchors, entryPoints: compiled.entryPoints }],
    assets: [
      { guid: "csp-scene", type: "Scene", sceneGuid: "csp-scene", bytes: encoder.encode(JSON.stringify(scene())) },
      { guid: "csp-probe-class", type: "Class", sceneGuid: "csp-scene", parentClass: "GameInstance", bytes: encoder.encode("{}") },
      { guid: "csp-particles", type: "ParticleSystem", sceneGuid: "csp-scene",
        bytes: encoder.encode(JSON.stringify({ ...createDefaultParticleSystemPayload(), emitterGuids: ["csp-graph"] })) },
      { guid: "csp-graph", type: "ParticleGraph", sceneGuid: "csp-scene", bytes: encoder.encode(JSON.stringify(createDefaultParticleGraphDocument())) },
    ],
    playerFiles,
  });
  if (!exported.ok) throw new Error(exported.error);
  // The scripts module ships beside game.json, and no compiled source travels anywhere else.
  const manifest = JSON.parse(new TextDecoder().decode(exported.value.files.get(GAME_MANIFEST_FILE)!)) as { scriptsModule?: { path: string } };
  expect(exported.value.files.has(manifest.scriptsModule!.path)).toBe(true);

  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`));
  });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("worker", (worker) => worker.on("console", (message) => { if (message.type() === "error") errors.push(`worker: ${message.text()}`); }));

  const server = await serveExportFiles(exported.value.files, { honorRange: true, headers: { "Content-Security-Policy": CSP } });
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("player-root")).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
    // A script from the static module ran.
    await expect(page.getByTestId("print-overlay")).toContainText("CSP script ran", { timeout: 30_000 });
    // Physics stepped: the dynamic box fell from its authored height.
    await expect.poll(() => page.evaluate(() => {
      const visuals = (window as unknown as { __hapticPlayerTest?: { visuals: () => Array<{ position: [number, number, number] }> } })
        .__hapticPlayerTest?.visuals() ?? [];
      return visuals.find((visual) => Math.abs(visual.position[0] - 6) < 0.01)?.position[1] ?? 8;
    }), { timeout: 30_000 }).toBeLessThan(7.5);
    // The Particle Graph system plays, its updates on the compiled tape.
    await expect.poll(() => page.evaluate(() => {
      const stats = (window as unknown as { __hapticParticleStats?: { graphSystems: number; playing: number } }).__hapticParticleStats;
      return stats ? Math.min(stats.graphSystems, stats.playing) : 0;
    }), { timeout: 30_000 }).toBeGreaterThan(0);
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
    // The player's styles are inline (`<style>` in index.html), which `default-src 'self'` also blocks; that is a
    // presentation matter, not code evaluation, and is checked separately from scripts here.
    expect(violations.filter((violation) => !violation.startsWith("style-src"))).toEqual([]);
    expect(errors.filter((message) => /unsafe-eval|Content Security Policy|EvalError/i.test(message))).toEqual([]);
  } finally {
    await server.close();
  }
});
