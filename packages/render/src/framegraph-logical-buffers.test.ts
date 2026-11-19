import { afterEach, describe, expect, it, vi } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

const FRAMEBUFFER = 0x8d40, DEPTH_ATTACHMENT = 0x8d00;

/**
 * A geometry pass as the spatial effects draw it: the view depth (MaxViewZ), normals and reflectivity (Zero), and its
 * own depth. The GPU boundary is recorded: attachment clears, framebuffer binds and invalidations.
 */
function fixture(options: { clearsDepth: boolean; discardsDepth: boolean; viewDepth?: boolean }) {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, textureFloatRender: true, textureHalfFloatRender: true, blendFloat: true });
  const invalidateFramebuffer = vi.fn();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  camera.setTarget(Vector3.Zero());
  camera.maxZ = 250;
  scene.activeCamera = camera;
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = new StandardMaterial("lit", scene);
  const graph = new FrameGraph(scene);
  disposers.push(() => { graph.dispose(); scene.dispose(); engine.dispose(); });
  const geometry = new LogicalGeometryTask("Geometry", graph, scene, { doNotChangeAspectRatio: false });
  geometry.camera = camera;
  geometry.objectList = { meshes: [mesh], particleSystems: [] };
  geometry.depthTexture = graph.textureManager.createRenderTargetTexture("Geometry Z", {
    size: { width: 16, height: 8 }, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_FLOAT], formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT], useSRGBBuffers: [false] },
  });
  geometry.clearsDepth = options.clearsDepth;
  geometry.discardsDepth = options.discardsDepth;
  geometry.size = { width: 16, height: 8 };
  geometry.sizeIsPercentage = false;
  geometry.samples = 1;
  geometry.textureDescriptions = [
    ...options.viewDepth === false ? [] : [{ type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RG }],
    { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
  ];
  graph.addTask(geometry);
  // What reaches the GPU while the pass's target is bound, in order.
  const calls: unknown[] = [];
  const target = () => (geometry.passes[0] as FrameGraphRenderPass).frameGraphRenderTarget.renderTargetWrapper;
  const current = () => (engine as unknown as { _currentRenderTarget: RenderTargetWrapper | null })._currentRenderTarget;
  vi.spyOn(engine, "clearAttachments").mockImplementation((color, attachments, clearColor, clearDepth, clearStencil) => {
    const clear = color ? [color.r, color.g, color.b, color.a] : null;
    calls.push({ clear, attachments, flags: [clearColor, clearDepth, clearStencil ?? false], bound: current() === target() });
  });
  const bind = engine.bindFramebuffer.bind(engine);
  vi.spyOn(engine, "bindFramebuffer").mockImplementation((wrapper: RenderTargetWrapper, ...rest) => {
    if (wrapper === target()) calls.push("bind");
    return bind(wrapper, ...rest);
  });
  const draw = vi.spyOn(geometry.objectRenderer, "render").mockImplementation(() => { calls.push({ draws: current() === target() }); });
  invalidateFramebuffer.mockImplementation((framebuffer: number, attachments: number[]) => {
    calls.push({ invalidate: framebuffer === FRAMEBUFFER ? attachments : framebuffer, bound: current() === target() });
  });
  const frame = async () => {
    await graph.buildAsync(false);
    calls.length = 0;
    // NullEngine has no WebGL context: supply the one call the pass makes on it, for this frame only.
    const internals = engine as unknown as { _gl: unknown };
    const gl = internals._gl;
    internals._gl = { FRAMEBUFFER, DEPTH_ATTACHMENT, invalidateFramebuffer };
    try { graph.execute(); } finally { internals._gl = gl; }
    return calls.slice();
  };
  return { frame, draw };
}

describe("LogicalGeometryTask", () => {
  it("binds its target once, clears each attachment once with the view depth at the far plane beside the depth, and discards the depth after its draws", async () => {
    const { frame, draw } = fixture({ clearsDepth: true, discardsDepth: true });
    expect(await frame()).toEqual([
      "bind",
      // Normals and reflectivity at Babylon's zero; never the view depth, which Babylon 9.29 would clear to zero first.
      { clear: [0, 0, 0, 0], attachments: [0, 0x8ce1, 0x8ce2], flags: [true, false, false], bound: true },
      // The view depth at the camera's far plane and the depth in one clear.
      { clear: [250, 0, 0, 1], attachments: [0x8ce0, 0, 0], flags: [true, true, false], bound: true },
      { draws: true },
      { invalidate: [DEPTH_ATTACHMENT], bound: true },
    ]);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("keeps its depth where nothing asks to discard it, and clears no depth unless asked", async () => {
    const { frame } = fixture({ clearsDepth: false, discardsDepth: false });
    expect(await frame()).toEqual([
      "bind",
      { clear: [0, 0, 0, 0], attachments: [0, 0x8ce1, 0x8ce2], flags: [true, false, false], bound: true },
      { clear: [250, 0, 0, 1], attachments: [0x8ce0, 0, 0], flags: [true, false, false], bound: true },
      { draws: true },
    ]);
  });

  it("prepares a pass without the view depth as Babylon does", async () => {
    const { frame } = fixture({ clearsDepth: false, discardsDepth: false, viewDepth: false });
    // Babylon's preparation ends on the backbuffer: the draws bind the target again.
    expect(await frame()).toEqual([
      "bind",
      { clear: [0, 0, 0, 0], attachments: [0x8ce0, 0x8ce1], flags: [true, false, false], bound: true },
      "bind",
      { draws: true },
    ]);
  });
});
