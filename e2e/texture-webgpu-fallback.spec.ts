import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  createActor,
  createDefaultScene,
  createDefaultSunActor,
  createMeshComponent,
  lookAtRotation,
} from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { importImage } from "../packages/assets/src/importers/image";
import { MATERIAL_PAYLOAD_VERSION, createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { normalizeParticleEmitterPayload } from "../packages/assets/src/particle-basic-emitter";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import type { ViewportProofResult, ViewportProofSubjectResult } from "../apps/editor/src/testing/webgpu-previews-proof";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const TEXTURE_GUID = "00000000-0000-4000-8000-000000000071";
const SURFACE_GUID = "00000000-0000-4000-8000-000000000072";
const PARTICLE_GUID = "00000000-0000-4000-8000-000000000073";
const TEXTURE_PATH = "assets/albedo.babasset";
const EMITTER_PATH = "assets/OddSparks.emitter.babasset";
/** Samples the texture through its surface Material. */
const TEXTURED_BOX = "actor-1";
/** No Material: the engine default material under the same light. */
const PLAIN_BOX = "plain-box";
/** Directional light from the camera's side, so the −Z faces the viewport samples are lit. */
const SUN_POSITION: [number, number, number] = [0, 8, -8];
/** The failure this fallback prevents: an unaligned block-compressed texture invalidates every frame. */
const GPU_FAILURE = /GPUValidationError|not a multiple of the block|Invalid CommandBuffer|GPU submission failed/;
const TEXTURE_MESSAGE = 'Texture "albedo" (1×1) was not drawn';

type Backend = "webgl2" | "webgpu";
type CompressedTexture = { format: string; width: number; height: number };

/** Init script: records every block-compressed WebGPU texture (the KTX2 transcode targets). */
function recordCompressedGpuTextures(): void {
  type Descriptor = { format: string; size: number[] | { width: number; height?: number } };
  const host = globalThis as {
    GPUDevice?: { prototype: { createTexture(descriptor: Descriptor): unknown } };
    __compressedGpuTextures?: CompressedTexture[];
  };
  const device = host.GPUDevice?.prototype;
  if (!device) return;
  const created: CompressedTexture[] = [];
  host.__compressedGpuTextures = created;
  const createTexture = device.createTexture;
  device.createTexture = function (this: unknown, descriptor: Descriptor) {
    if (/^(bc|astc|etc2|eac)/.test(descriptor.format)) {
      const size = descriptor.size;
      const [width = 1, height = 1] = Array.isArray(size) ? size : [size.width, size.height];
      created.push({ format: descriptor.format, width, height });
    }
    return createTexture.call(this, descriptor);
  };
}

/**
 * `e2e/fixtures/albedo.png` (1×1 pure red) through the image importer: an
 * Albedo Texture still `pending`, so opening the project encodes a 1×1 KTX2.
 * A surface Material samples it on the box and a particle Material in an
 * Emitter; a second box has no Material.
 */
async function fixture(backend: Backend): Promise<Map<string, Uint8Array>> {
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = backend;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const migrations = createDefaultMigrationRegistry();
  const png = new Uint8Array(await readFile(path.join(process.cwd(), "e2e/fixtures/albedo.png")));
  const [texture] = await importImage(png, { fileName: "albedo.png" });
  expect(texture!.payload).toMatchObject({ usage: "albedo", width: 1, height: 1, compressionState: "pending" });
  files.set(TEXTURE_PATH, await encodeAssetDocument(
    { guid: TEXTURE_GUID, type: "Texture", name: texture!.name, version: texture!.version, payload: texture!.payload },
    { headerPayload: texture!.payload, extraChunks: texture!.chunks },
  ));
  for (const [guid, domain, name] of [[SURFACE_GUID, "surface", "OddSurface"], [PARTICLE_GUID, "particle", "OddParticle"]] as const) {
    const material = createDefaultMaterialDocument(name, domain);
    material.nodes.push({ id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: TEXTURE_GUID } });
    material.edges = [{ id: "sample-output", sourceNodeId: "sample", sourcePinId: domain === "particle" ? "rgba" : "rgb",
      targetNodeId: "output", targetPinId: domain === "particle" ? "color" : "baseColor" }];
    files.set(`assets/${name}.material.babasset`, await encodeAssetDocument({
      guid, type: "Material", name, version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
    }, { dependencies: [TEXTURE_GUID] }));
  }
  files.set(EMITTER_PATH, await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000074", type: "ParticleEmitter", name: "OddSparks",
    version: migrations.currentVersion("ParticleEmitter"),
    payload: normalizeParticleEmitterPayload({ render: { materialGuid: PARTICLE_GUID } }) as unknown as Record<string, unknown>,
  }, { dependencies: [PARTICLE_GUID] }));
  const scene = createDefaultScene();
  scene.settings.grid.showGrid = false;
  const textured = createMeshComponent("mesh-1", "box");
  textured.properties.materialGuid = SURFACE_GUID;
  const sun = createDefaultSunActor(lookAtRotation(SUN_POSITION, [0, 0, 0]));
  sun.transform.position = [...SUN_POSITION];
  sun.components[0]!.properties.castShadows = false;
  scene.actors = [
    createActor(TEXTURED_BOX, "Actor", { classId: "Main", components: [textured] }),
    createActor(PLAIN_BOX, "Plain Box", {
      transform: { position: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [createMeshComponent("plain-mesh", "box")],
    }),
    sun,
    ...scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId),
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: project.settings.startupSceneGuid, type: "Scene", name: "Main",
    version: migrations.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: ["00000000-0000-4000-8000-000000000002", SURFACE_GUID] }));
  return files;
}

async function compressionState(page: Page): Promise<string | null> {
  return page.evaluate((path) => (globalThis as {
    __babylonslateTest?: { textureEncodeState?: (path: string) => { compressionState: string | null } | null };
  }).__babylonslateTest?.textureEncodeState?.(path)?.compressionState ?? null, TEXTURE_PATH);
}

/** Open the project, then the scene once the Albedo KTX2 exists, so the viewport binds the 1×1 KTX2 rather than the PNG. */
async function openSceneWithEncodedTexture(page: Page, backend: Backend): Promise<void> {
  await openMinimalTestProject(page, await fixture(backend));
  await expect.poll(() => compressionState(page), { timeout: 60_000 }).toBe("compressed");
  await openMainScene(page);
}

async function viewportProof(page: Page, testInfo: TestInfo, label: string): Promise<ViewportProofResult> {
  const proof = await page.evaluate((trackedActorIds) => (globalThis as unknown as {
    __babylonslateViewportTest: {
      webgpuPreviewsProof: (options: { frames: number; timeoutMs: number; trackedActorIds: string[] }) => Promise<ViewportProofResult>;
    };
  }).__babylonslateViewportTest.webgpuPreviewsProof({ frames: 30, timeoutMs: 30_000, trackedActorIds }), [TEXTURED_BOX, PLAIN_BOX]);
  await testInfo.attach(label, { body: JSON.stringify({ ...proof, frames: undefined }), contentType: "application/json" });
  return proof;
}

function subject(proof: ViewportProofResult, actorId: string): ViewportProofSubjectResult {
  return proof.subjects.find((entry) => entry.actorId === actorId)!;
}

/** The lit 1×1 pure-red albedo.png. */
function readsRed(pixel: number[] | null | undefined): boolean {
  const [r = 0, g = 0, b = 0] = pixel ?? [];
  return r >= 60 && r > 2 * Math.max(g, b);
}

/** The engine default material (a 0.8 / 0.65 grey checker) under the warm sun: lit and near neutral. */
function readsLitGrey(pixel: number[] | null | undefined): boolean {
  const [r = 0, g = 0, b = 0] = pixel ?? [];
  const max = Math.max(r, g, b);
  return max >= 60 && max - Math.min(r, g, b) <= max * 0.3;
}

/** Frames keep presenting and both boxes draw over the background. */
function expectPresenting(proof: ViewportProofResult, backend: Backend): void {
  expect(proof.backend).toBe(backend);
  expect(proof.timedOut).toBe(false);
  expect(proof.engineErrors).toEqual([]);
  for (const actorId of [TEXTURED_BOX, PLAIN_BOX]) {
    const entry = subject(proof, actorId);
    expect(entry.realizedAtFrame, actorId).not.toBeNull();
    expect(entry.backgroundPixelFrames, actorId).toBe(0);
  }
  // An invalid command buffer presents nothing: the sky corner would read transparent black.
  expect(proof.skybox[0]!.pixels.at(-1)!.some((channel) => channel > 0)).toBe(true);
}

test("WebGPU skips a texture off the 4×4 block grid: default material, No Material particles, Play reports it", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const gpuFailures: string[] = [];
  page.on("console", (message) => {
    if (GPU_FAILURE.test(message.text())) gpuFailures.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
  });
  page.on("pageerror", (error) => {
    if (GPU_FAILURE.test(error.message)) gpuFailures.push(`[pageerror] ${error.message}`);
  });
  await page.addInitScript(recordCompressedGpuTextures);
  await openSceneWithEncodedTexture(page, "webgpu");

  // Scene viewport: frames keep presenting and the textured box draws like the box with no Material.
  const opened = await viewportProof(page, testInfo, "viewport-opened");
  expectPresenting(opened, "webgpu");
  for (const actorId of [TEXTURED_BOX, PLAIN_BOX]) {
    const pixel = subject(opened, actorId).last?.pixel;
    expect(readsLitGrey(pixel), `${actorId} ${pixel}`).toBe(true);
  }

  // Emitter Preview: the particle Material is unavailable and says why.
  await openAssetFromBrowser(page, EMITTER_PATH);
  const empty = page.getByTestId("particle-emitter-preview").getByTestId("particle-preview-empty");
  await expect(empty).toContainText("No Material", { timeout: 30_000 });
  await expect(empty).toContainText(TEXTURE_MESSAGE);
  await expect(empty).toContainText("Set its Usage to Particle.");

  // Long after the texture was refused, the viewport still draws the default material.
  await openMainScene(page);
  const settled = await viewportProof(page, testInfo, "viewport-settled");
  expectPresenting(settled, "webgpu");
  const settledPixel = subject(settled, TEXTURED_BOX).last?.pixel;
  expect(readsLitGrey(settledPixel), `${TEXTURED_BOX} ${settledPixel}`).toBe(true);

  // Play runs on, then the session report names the texture and the fix.
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("play-log-tail")).toContainText(TEXTURE_MESSAGE, { timeout: 60_000 });
  const tick = () => page.evaluate(() => (globalThis as unknown as { __babylonslatePlayTest?: { tickIndex(): number } }).__babylonslatePlayTest?.tickIndex() ?? 0);
  const started = await tick();
  await expect.poll(tick, { timeout: 30_000 }).toBeGreaterThan(started + 30);
  await expect(page.getByTestId("play-overlay")).toBeVisible();
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  const report = page.getByTestId("preview-session-report");
  await expect(report).toBeVisible();
  const rows = report.getByTestId("session-report-row");
  await testInfo.attach("session-report", { body: JSON.stringify(await rows.allTextContents()), contentType: "application/json" });
  // Play collects both Materials, so the row offers both fixes.
  await expect(rows.filter({ hasText: TEXTURE_MESSAGE })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Set its Usage to Particle, or resize the image to a multiple of 4 pixels." })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Scene loading failed" })).toHaveCount(0);

  const compressed = await page.evaluate(() => (globalThis as { __compressedGpuTextures?: CompressedTexture[] }).__compressedGpuTextures ?? null);
  await testInfo.attach("gpu", { body: JSON.stringify({ compressed, gpuFailures }), contentType: "application/json" });
  expect(compressed).not.toBeNull();
  expect(compressed!.filter((texture) => texture.width % 4 !== 0 || texture.height % 4 !== 0)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});

test("WebGL2 keeps drawing the same unaligned Albedo KTX2", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openSceneWithEncodedTexture(page, "webgl2");
  let proof = undefined as ViewportProofResult | undefined;
  // The textured Material compiles after the scene opens; the default material shows until then.
  await expect(async () => {
    proof = await viewportProof(page, testInfo, "viewport-webgl2");
    const pixel = subject(proof, TEXTURED_BOX).last?.pixel;
    expect(readsRed(pixel), `${TEXTURED_BOX} ${pixel}`).toBe(true);
  }).toPass({ timeout: 60_000 });
  expectPresenting(proof!, "webgl2");
  const plain = subject(proof!, PLAIN_BOX).last?.pixel;
  expect(readsLitGrey(plain), `${PLAIN_BOX} ${plain}`).toBe(true);
});
