import { Constants } from "@babylonjs/core/Engines/constants";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Scene } from "@babylonjs/core/scene";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultRenderTargetCaptureProperties, normalizeShadowSettings } from "@haptic/core";
import { beginEngineDrawCallFrame } from "./draw-calls";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { Observable } from "@babylonjs/core/Misc/observable";
import {
  beginDrawPassFrame, DrawPassFrame, emptyDrawPasses, endDrawPassFrame, enterDrawPass, leaveDrawPass, observeTaskDrawPass,
  publishDrawPassFrame, withDrawPass,
} from "./draw-passes";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { timeParticleAnimation } from "./particle-animation-pass";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { RenderTargetCaptures } from "./render-target-capture";
import { DisplayConversion } from "./display-conversion";
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

  /** A main-thread clock the test advances, as each pass's JavaScript does. */
  const clock = () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    return (ms: number) => { now += ms; };
  };

  it("times each pass as it counts draws: the innermost pass running, an owner keeping what it nests, summing to the frame", () => {
    const { engine } = counter();
    const spend = clock();
    const frame = new DrawPassFrame(engine);
    frame.timePasses();
    beginDrawPassFrame(frame);
    spend(1);
    enterDrawPass(engine, "shadows");
    spend(4);
    leaveDrawPass(engine);
    withDrawPass(engine, "captures", () => {
      spend(2);
      enterDrawPass(engine, "shadows");
      spend(3);
      leaveDrawPass(engine);
      enterDrawPass(engine, "objects");
      spend(5);
      leaveDrawPass(engine);
    });
    enterDrawPass(engine, "objects");
    spend(7);
    enterDrawPass(engine, "post");
    spend(2);
    leaveDrawPass(engine);
    spend(1);
    leaveDrawPass(engine);
    spend(1);
    endDrawPassFrame(frame);
    // After the frame ended: no pass's.
    spend(9);
    publishDrawPassFrame(frame);
    expect(frame.lastMs).toEqual({ ...emptyDrawPasses(), other: 2, shadows: 4, captures: 10, objects: 8, post: 2 });
    expect(Object.values(frame.lastMs).reduce((sum, ms) => sum + ms, 0)).toBe(26);
  });

  it("times the cull, readiness, particle and observer passes as the innermost pass, with the rest to `other`", () => {
    const { engine } = counter();
    const spend = clock();
    const frame = new DrawPassFrame(engine);
    frame.timePasses();
    beginDrawPassFrame(frame);
    withDrawPass(engine, "readiness", () => spend(2), false);
    enterDrawPass(engine, "observers");
    spend(3);
    // A Mirror's update inside a before-render observer is the mirror's, not the observers'.
    withDrawPass(engine, "mirrors", () => spend(5));
    spend(1);
    leaveDrawPass(engine);
    spend(4);
    withDrawPass(engine, "particles", () => spend(7), false);
    withDrawPass(engine, "cull", () => spend(11), false);
    endDrawPassFrame(frame);
    publishDrawPassFrame(frame);
    expect(frame.lastMs).toEqual({ ...emptyDrawPasses(), readiness: 2, observers: 4, mirrors: 5, other: 4, particles: 7, cull: 11 });
    expect(Object.values(frame.lastMs).reduce((sum, ms) => sum + ms, 0)).toBe(33);
    // They draw nothing unless something does inside them.
    expect(frame.last).toEqual(emptyDrawPasses());
  });

  it("opens a task's pass before the task's own observers, and closes it before what runs after the task", () => {
    const { engine } = counter();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const task = { onBeforeTaskExecute: new Observable<unknown>(), onAfterTaskExecute: new Observable<unknown>() };
    // The task's own preparation, added when the task was made (a shared outline's sync).
    task.onBeforeTaskExecute.add(() => { now += 4; });
    observeTaskDrawPass(task as unknown as FrameGraphTask, engine, "outlines");
    // What the scene view draws after the task (its capture views), added later.
    task.onAfterTaskExecute.add(() => { now += 2; });
    const frame = new DrawPassFrame(engine);
    frame.timePasses();
    beginDrawPassFrame(frame);
    task.onBeforeTaskExecute.notifyObservers(task);
    now += 3;
    task.onAfterTaskExecute.notifyObservers(task);
    endDrawPassFrame(frame);
    publishDrawPassFrame(frame);
    expect(frame.lastMs).toMatchObject({ outlines: 7, other: 2 });
  });

  it("brackets each started particle system's animation once as `particles`, and only inside a frame", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const spend = clock();
    const system = new ParticleSystem("sparks", 8, scene);
    let animations = 0;
    system.animate = (() => { animations += 1; spend(6); }) as typeof system.animate;
    timeParticleAnimation(scene);
    // A second sweep does not wrap it again: its time would otherwise count in nested pairs, harmlessly, but its call
    // chain would grow with every frame.
    const wrapped = system.animate;
    timeParticleAnimation(scene);
    expect(system.animate).toBe(wrapped);
    // Outside a frame it only calls through.
    system.animate();
    expect(animations).toBe(1);
    const frame = new DrawPassFrame(engine);
    frame.timePasses();
    beginDrawPassFrame(frame);
    spend(1);
    system.animate();
    system.animate();
    endDrawPassFrame(frame);
    publishDrawPassFrame(frame);
    expect(animations).toBe(3);
    expect(frame.lastMs).toEqual({ ...emptyDrawPasses(), other: 1, particles: 12 });
  });

  it("times nothing until asked, and from the next frame begun once asked mid-frame", () => {
    const { engine } = counter();
    const spend = clock();
    const frame = new DrawPassFrame(engine);
    const render = () => {
      beginDrawPassFrame(frame);
      spend(1);
      withDrawPass(engine, "mirrors", () => spend(3));
      if (!asked) { asked = true; frame.timePasses(); }
      spend(2);
      endDrawPassFrame(frame);
      publishDrawPassFrame(frame);
      return { ...frame.lastMs };
    };
    let asked = false;
    expect(render()).toEqual(emptyDrawPasses());
    expect(render()).toEqual({ ...emptyDrawPasses(), other: 3, mirrors: 3 });
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
    // The pass that stores the capture's image compiles in a browser: here it is ready, and its one draw is counted.
    vi.spyOn(DisplayConversion.prototype, "ready").mockReturnValue(true);
    vi.spyOn(DisplayConversion.prototype, "draw").mockImplementation(() => { engine.drawElementsType(0, 0, 6); });
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
    // The spot light's one map draws its one caster; the capture and the objects pass each draw the caster and the
    // floor, and the capture stores its image in one more draw.
    expect(render()).toEqual({ passes: { ...emptyDrawPasses(), shadows: 1, captures: 3, objects: 2 }, total: 6 });
    // A map draws only when what it holds changes: a static frame draws the capture and the objects again.
    expect(render()).toEqual({ passes: { ...emptyDrawPasses(), captures: 3, objects: 2 }, total: 5 });
    caster.position.x = 0.25;
    expect(render().passes).toEqual({ ...emptyDrawPasses(), shadows: 1, captures: 3, objects: 2 });
    graph.dispose();
    captures.dispose();
  });

  it("times a frame's cull, readiness, particle animation and before-render observers as their own passes, adding up to the frame", async () => {
    const { engine, scene, camera } = host();
    const material = new StandardMaterial("opaque", scene);
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = material;
    new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
    await material.forceCompilationAsync(box);
    const system = new ParticleSystem("sparks", 8, scene);
    system.emitter = Vector3.Zero();
    // NullEngine compiles no particle effect and draws nothing: stub only its readiness and native draw.
    vi.spyOn(system, "isReady").mockReturnValue(true);
    vi.spyOn(system, "render").mockReturnValue(0);
    const graph = new ForwardSceneFrameGraph(scene);
    expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
    // A started system: Babylon animates it, and the test's own animation stands in for its CPU update.
    vi.spyOn(system, "isStarted").mockReturnValue(true);
    let now = 5000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const spend = (ms: number) => { now += ms; };
    system.animate = (() => spend(13)) as typeof system.animate;
    scene.onBeforeRenderObservable.add(() => spend(3));
    scene.onBeforeRenderObservable.add(() => withDrawPass(engine, "mirrors", () => spend(5)));
    // The cull task's own work: some before Babylon's task runs, and Babylon's frustum test inside the task's pass.
    const execute = (FrameGraphCullObjectsTask.prototype as unknown as { _execute(): void })._execute;
    vi.spyOn(FrameGraphCullObjectsTask.prototype as unknown as { _execute(): void }, "_execute")
      .mockImplementation(function (this: FrameGraphCullObjectsTask) { spend(4); execute.call(this); });
    const inFrustum = box.isInFrustum.bind(box);
    vi.spyOn(box, "isInFrustum").mockImplementation((planes) => { spend(3); return inFrustum(planes); });
    vi.spyOn(graph as unknown as { syncShadowAdmission(): void }, "syncShadowAdmission").mockImplementation(() => spend(2));
    const frame = new DrawPassFrame(engine);
    frame.timePasses();
    const render = () => {
      beginEngineDrawCallFrame(engine);
      beginDrawPassFrame(frame);
      const started = now;
      expect(graph.render(camera, false).path).toBe("frameGraph");
      endDrawPassFrame(frame);
      publishDrawPassFrame(frame);
      return { ms: { ...frame.lastMs }, span: now - started };
    };
    // The first frame finds the particle system and wraps it; its animation ran after that, inside the same frame.
    for (let frames = 0; frames < 2; frames += 1) {
      const { ms, span } = render();
      expect(ms).toMatchObject({ cull: 7, readiness: 2, particles: 13, observers: 3, mirrors: 5 });
      // Nothing else spent time, and what each pass holds adds up to the frame's span.
      expect(ms.other).toBe(0);
      expect(Object.values(ms).reduce((sum, value) => sum + value, 0)).toBe(span);
    }
    // The existing split is untouched: this frame drew the box once and nothing else drew.
    expect(frame.last).toEqual({ ...emptyDrawPasses(), objects: 1 });
    graph.dispose();
  });
});
