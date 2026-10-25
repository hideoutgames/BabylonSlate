import { Observable, type AbstractMesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";
import { beforeEach, expect, it } from "vitest";
import { renderTrackingCasters } from "./shadow-caster-warm";
import { setAwaitingFirstDraw } from "./shadow-first-draw";
import { firstDrawPipelinesReady, WARM_MAP_PIPELINES_PER_FRAME } from "./shadow-map-warm";
import { webGpuEngine } from "./webgpu-test-fixtures";

beforeEach(() => WebGPUCacheRenderPipelineTree.ResetCache());

it("charges the pipelines a drawn map's new caster starts to the frame's warm budget, so a first map's warm render waits", () => {
  // The real deferral on Babylon's pipeline cache: a skipped caster draw that misses starts its pipeline asynchronously.
  const { engine, device, draw } = webGpuEngine();
  const scene = { getEngine: () => engine } as unknown as Scene;
  const before = new Observable<AbstractMesh>();
  const after = new Observable<AbstractMesh>();
  // The members a tracked render reads of a map drawing into render pass 9, whose casters Babylon's shadow pass
  // announces around each caster's draws.
  const drawnMap = {
    getLight: () => ({ getScene: () => scene }),
    getShadowMap: () => ({ renderPassIds: [9] }),
    onBeforeShadowMapRenderMeshObservable: before,
    onAfterShadowMapRenderMeshObservable: after,
  } as unknown as ShadowGenerator;
  const established = {} as AbstractMesh;
  const spawned = {} as AbstractMesh;
  const caster = (mesh: AbstractMesh, effects: number[]) => {
    before.notifyObservers(mesh);
    for (const effect of effects) draw(effect, 9);
    after.notifyObservers(mesh);
  };
  renderTrackingCasters(drawnMap, false, () => caster(established, [1]));
  engine._frameId += 1;
  // A steady frame: the new caster's draws miss as many pipelines as one Engine frame may start.
  const misses = Array.from({ length: WARM_MAP_PIPELINES_PER_FRAME }, (_, index) => 2 + index);
  renderTrackingCasters(drawnMap, true, () => {
    caster(established, [1]);
    caster(spawned, misses);
  });
  const firstMap = { getShadowMap: () => ({ renderPassIds: [10] }) } as unknown as ShadowGenerator;
  setAwaitingFirstDraw(firstMap, true);
  const rendered: number[] = [];
  const renderFirstMap = () => {
    rendered.push(engine.frameId);
    draw(100, 10);
  };
  firstDrawPipelinesReady(scene, firstMap, renderFirstMap);
  const startedThen = device.createRenderPipelineAsync.mock.calls.length;
  engine._frameId += 1;
  firstDrawPipelinesReady(scene, firstMap, renderFirstMap);
  expect({ startedThen, rendered }).toEqual({ startedThen: WARM_MAP_PIPELINES_PER_FRAME, rendered: [2] });
});
