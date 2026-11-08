import { Constants } from "@babylonjs/core/Engines/constants";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultRenderTargetCaptureProperties, normalizeShadowSettings } from "@haptic/core";
import { beginEngineDrawCallFrame } from "./draw-calls";
import {
  beginDrawPassFrame, DrawPassFrame, emptyDrawPasses, endDrawPassFrame, enterDrawPass, leaveDrawPass, publishDrawPassFrame,
  withDrawPass,
} from "./draw-passes";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { RenderTargetCaptures } from "./render-target-capture";
import { updateSceneRenderingSettings } from "./render-settings";
import { sceneShadowController } from "./shadow-controller";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("DrawPassFrame", () => {
  /** An Engine whose per-frame draw counter the test advances, as each GL draw does through `_reportDrawCall`. */
  const counter = () => {
    const engine = { _drawCalls: { current: 0, fetchNewFrame() { this.current = 0; } } };
    return { engine, draw: (count: number) => { engine._drawCalls.current += count; } };
  };

  it("counts each draw to the innermost pass running, and what an owner pass nests to the owner", () => {
    const { engine, draw } = counter();
    const frame = new DrawPassFrame(engine);
    beginEngineDrawCallFrame(engine);
    beginDrawPassFrame(frame);
    draw(1);
    enterDrawPass(engine, "shadows");
    draw(4);
    leaveDrawPass(engine);
    // A capture view's own graph: its shadow maps and objects are the capture's.
    withDrawPass(engine, "captures", () => {
      draw(2);
      enterDrawPass(engine, "shadows");
      draw(3);
      leaveDrawPass(engine);
      enterDrawPass(engine, "objects");
      draw(5);
      leaveDrawPass(engine);
    });
    enterDrawPass(engine, "objects");
    draw(7);
    // A task nested in a non-owner pass counts as itself.
    enterDrawPass(engine, "post");
    draw(2);
    leaveDrawPass(engine);
    draw(1);
    leaveDrawPass(engine);
    draw(1);
    endDrawPassFrame(frame);
    // Drawn after the frame ended: no pass's.
    draw(9);
    expect(frame.last).toEqual(emptyDrawPasses());
    publishDrawPassFrame(frame);
    expect(frame.last).toEqual({ ...emptyDrawPasses(), other: 2, shadows: 4, captures: 10, objects: 8, post: 2 });
  });

  it("starts every frame from zero, keeps the last published frame, and ignores passes outside a frame or on another Engine", () => {
    const { engine, draw } = counter();
    const other = counter();
    const frame = new DrawPassFrame(engine);
    enterDrawPass(engine, "mirrors");
    draw(3);
    leaveDrawPass(engine);
    beginEngineDrawCallFrame(engine);
    beginDrawPassFrame(frame);
    withDrawPass(other.engine, "water", () => draw(2));
    withDrawPass(engine, "mirrors", () => draw(1));
    endDrawPassFrame(frame);
    publishDrawPassFrame(frame);
    expect(frame.last).toMatchObject({ mirrors: 1, water: 0, other: 2 });
    // A held frame (never published) leaves the last drawn one in place.
    beginEngineDrawCallFrame(engine);
    beginDrawPassFrame(frame);
    withDrawPass(engine, "mirrors", () => draw(6));
    endDrawPassFrame(frame);
    expect(frame.last).toMatchObject({ mirrors: 1, other: 2 });
    expect(frame.current).toMatchObject({ mirrors: 6, other: 0 });
  });
});

describe("draw passes of a Forward graph frame", () => {
  /**
   * NullEngine never reports a draw (its `drawElementsType` and `drawArraysType` are empty); report each one as the
   * WebGL2 engine's do, so every task, map and target below draws and counts for real.
   */
  function host() {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096 });
    engine._features.supportShadowSamplers = true;
    engine.drawElementsType = function (this: NullEngine) { this._reportDrawCall(); };
    engine.drawArraysType = function (this: NullEngine) { this._reportDrawCall(); };
    // NullEngine does not record the GPU allocator's format metadata the capture's ledger reconciles.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    vi.spyOn(engine, "createRenderTargetTexture").mockImplementation((size, options) => {
      const target = allocate(size, options);
      target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
      return target;
    });
    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 2, -7), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, localMapSize: 256, mapSize: 256, maxLocalLights: 1 }),
    });
    return { engine, scene, camera };
  }

  it("splits a frame's draws between the shadow map, a Fast capture and the objects pass, and they add up to the frame's", async () => {
    const { engine, scene, camera } = host();
    const material = new StandardMaterial("opaque", scene);
    const caster = MeshBuilder.CreateBox("caster", {}, scene);
    caster.material = material;
    const floor = MeshBuilder.CreateGround("floor", { width: 6, height: 6 }, scene);
    floor.position.y = -0.5;
    floor.material = material;
    const light = new SpotLight("spot", new Vector3(0, 3, -2), new Vector3(0, -1, 0.5), Math.PI / 2, 1, scene);
    const shadows = sceneShadowController(scene);
    shadows.register(light, true);
    shadows.sync();
    shadows.setParticipation(floor, { castShadows: false });
    shadows.sync();
    const generator = shadows.generator(light)!;
    await material.forceCompilationAsync(caster);
    await generator.forceCompilationAsync();
    // An every-frame Fast capture, from behind the caster toward it, of the whole scene.
    const captures = new RenderTargetCaptures(scene);
    captures.setAssets(new Map([["target", { mode: "SceneColor", width: 16, height: 8 }]]), new Map([["texture", { renderTargetGuid: "target" }]]));
    const root = new Mesh("Capture Root", scene);
    root.position.set(0, 1, -4);
    captures.configure("capture", { ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: "target" }, () => root);
    captures.acquireTexture("texture");
    const graph = new ForwardSceneFrameGraph(scene);
    expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
    const frame = new DrawPassFrame(engine);
    const render = () => {
      beginEngineDrawCallFrame(engine);
      beginDrawPassFrame(frame);
      // The first frame draws, though the capture's new target asks the graph to probe again.
      expect(graph.render(camera, false).path).toBe("frameGraph");
      endDrawPassFrame(frame);
      publishDrawPassFrame(frame);
      return { passes: { ...frame.last }, total: engine._drawCalls.current };
    };
    // The spot light's one map draws its one caster; the capture and the objects pass each draw the caster and the floor.
    expect(render()).toEqual({ passes: { ...emptyDrawPasses(), shadows: 1, captures: 2, objects: 2 }, total: 5 });
    // A map draws only when what it holds changes: a static frame draws the capture and the objects again.
    expect(render()).toEqual({ passes: { ...emptyDrawPasses(), captures: 2, objects: 2 }, total: 4 });
    caster.position.x = 0.25;
    expect(render().passes).toEqual({ ...emptyDrawPasses(), shadows: 1, captures: 2, objects: 2 });
    graph.dispose();
    captures.dispose();
  });
});
