import { FreeCamera, MeshBuilder, NullEngine, NullEngineOptions, RenderTargetTexture, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphTextureManager } from "@babylonjs/core/FrameGraph/frameGraphTextureManager";
import { SceneRenderCoordinator } from "./scene-render-coordinator";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

function host() {
  const options = new NullEngineOptions();
  options.renderWidth = 80;
  options.renderHeight = 64;
  const engine = new NullEngine(options);
  engines.push(engine);
  // NullEngine lacks this MRT driver boundary; keep the real graph/tasks and
  // native Scene readiness, camera ownership and drawing paths.
  vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled, backbuffer) =>
    backbuffer ? [0x0405] : enabled.map((value, index) => value ? 0x8ce0 + index : 0));
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(() => {});
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const renderer = new SceneRenderCoordinator(scene);
  return { options, engine, scene, camera, renderer };
}

function holdGraphInitialization() {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const initialize = FrameGraph.prototype._whenAsynchronousInitializationDoneAsync;
  vi.spyOn(FrameGraph.prototype, "_whenAsynchronousInitializationDoneAsync").mockImplementationOnce(async function (this: FrameGraph) {
    await initialize.call(this);
    entered();
    await gate;
  });
  return { started, release };
}

it("never presents an unready scene or acknowledges a temporary native fallback as a prepared graph frame", async () => {
  const { scene, renderer } = host();
  let assetsReady = false;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const frame = vi.fn();
  scene.onAfterRenderObservable.add(frame);
  expect(renderer.render()).toMatchObject({ rendered: false, readyForPresentation: false });
  expect(frame).not.toHaveBeenCalled();
  assetsReady = true;
  expect(renderer.render()).toMatchObject({ path: "classic", rendered: true, readyForPresentation: false });
  expect(frame).toHaveBeenCalledTimes(1);
  await renderer.prepare();
  expect(frame).toHaveBeenCalledTimes(1);
  expect(renderer.isReady()).toBe(true);
  expect(renderer.render()).toEqual({ path: "frameGraph", rendered: true, readyForPresentation: true });
  expect(frame).toHaveBeenCalledTimes(2);
  renderer.dispose();
});

it("restarts camera and resized-output preparation without drawing or releasing a stale first-frame permit", async () => {
  const { options, scene, renderer } = host();
  let assetsReady = false;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const frame = vi.fn();
  scene.onBeforeRenderObservable.add(frame);
  const preparing = renderer.prepare();
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  const replacement = new FreeCamera("replacement", new Vector3(0, 0, -8), scene);
  scene.activeCamera = replacement;
  options.renderWidth = 96;
  options.renderHeight = 72;
  expect(renderer.isReady()).toBe(false);
  assetsReady = true;
  expect(await preparing).toEqual({ path: "frameGraph" });
  expect(frame).not.toHaveBeenCalled();
  expect(scene.activeCamera).toBe(replacement);
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  expect(scene.activeCamera).toBe(replacement);
  expect(scene.objectRenderers).toHaveLength(1);
  renderer.dispose();
});

it("rejects a superseded owner while allowing its replacement to finish preparation", async () => {
  const { scene, renderer } = host();
  let assetsReady = false;
  let current = true;
  scene.addIsReadyCheck({ isReady: () => assetsReady });
  const first = expect(renderer.prepare(() => { if (!current) throw new Error("old owner cancelled"); })).rejects.toThrow("old owner cancelled");
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  current = false;
  renderer.invalidate();
  const replacement = renderer.prepare();
  assetsReady = true;
  await first;
  expect(await replacement).toEqual({ path: "frameGraph" });
  expect(scene.objectRenderers).toHaveLength(1);
  expect(renderer.render()).toMatchObject({ path: "frameGraph", readyForPresentation: true });
  renderer.dispose();
});

it("disposes a pending graph without stranding readiness or touching a sibling scene", async () => {
  const { engine, scene, renderer } = host();
  scene.addIsReadyCheck({ isReady: () => false });
  const pending = expect(renderer.prepare()).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  renderer.dispose();
  await pending;
  expect(scene.objectRenderers).toHaveLength(0);
  const sibling = new Scene(engine);
  sibling.activeCamera = new FreeCamera("sibling", Vector3.Zero(), sibling);
  expect(() => sibling.render()).not.toThrow();
  expect(engine.isDisposed).toBe(false);
});

it("does not resume native task allocation after disposal during asynchronous initialization", async () => {
  const { scene, renderer } = host();
  const { started, release } = holdGraphInitialization();
  const allocate = vi.spyOn(FrameGraphTextureManager.prototype, "_allocateTextures");
  const pending = expect(renderer.prepare()).rejects.toThrow("disposed");
  await started;
  renderer.dispose();
  release();
  await pending;
  expect(allocate).not.toHaveBeenCalled();
  expect(scene.objectRenderers).toHaveLength(0);
});

it("does not acknowledge a changed-output fallback until its pending preparation settles", async () => {
  const { scene, camera, renderer } = host();
  const { started, release } = holdGraphInitialization();
  const pending = renderer.prepare();
  await started;
  const target = new RenderTargetTexture("native target", 32, scene);
  camera.outputRenderTarget = target;
  try {
    expect(renderer.isReady()).toBe(false);
    expect(renderer.render()).toMatchObject({ path: "classic", rendered: true, readyForPresentation: false });
  } finally {
    release();
    await pending;
  }
  expect(await pending).toMatchObject({ path: "classic", reason: expect.stringContaining("color/depth") });
  expect(renderer.isReady()).toBe(true);
  expect(renderer.render()).toMatchObject({ path: "classic", readyForPresentation: true });
  expect(camera.outputRenderTarget).toBe(target);
  renderer.dispose();
  expect(target.getInternalTexture()).not.toBeNull();
});

it("rejects the loading owner at the preparation deadline instead of accepting a timeout as classic readiness", async () => {
  const { scene, renderer } = host();
  scene.addIsReadyCheck({ isReady: () => false });
  const pending = expect(renderer.prepare()).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(scene.objectRenderers).toHaveLength(1));
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 10_001);
  await pending;
  expect(scene.objectRenderers).toHaveLength(0);
  renderer.dispose();
});

it("admits the native frozen queue as an explicit ready fallback", async () => {
  const { scene, renderer } = host();
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  await new Promise<void>((resolve) => scene.freezeActiveMeshes(false, resolve));
  const drawn = vi.spyOn(mesh, "render");
  expect(await renderer.prepare()).toMatchObject({ path: "classic", reason: expect.stringContaining("Frozen") });
  expect(drawn).not.toHaveBeenCalled();
  expect(renderer.isReady()).toBe(true);
  expect(renderer.render()).toMatchObject({ path: "classic", rendered: true, readyForPresentation: true });
  expect(drawn).toHaveBeenCalledTimes(1);
  renderer.dispose();
});


it("retires pending allocation before the host releases a borrowed target", async () => {
  const { scene, camera, renderer } = host();
  const target = new RenderTargetTexture("borrowed output", 32, scene);
  // NullEngine has no depth-texture driver; this cancellation case never builds
  // or draws attachments. Supply the supported-target boundary only.
  vi.spyOn(target, "depthStencilTexture", "get").mockReturnValue(target.getInternalTexture());
  camera.outputRenderTarget = target;
  const { started, release } = holdGraphInitialization();
  const pending = expect(renderer.prepare()).rejects.toThrow("disposed");
  await started;
  let retired = false;
  const retirement = renderer.retire().then(() => { retired = true; });
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(target.getInternalTexture()).not.toBeNull();
  release();
  await pending;
  await retirement;
  expect(scene.objectRenderers).toHaveLength(0);
  expect(target.getInternalTexture()).not.toBeNull();
  target.dispose();
});
