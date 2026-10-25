import type { Scene, ShadowGenerator } from "@babylonjs/core";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setAwaitingFirstDraw } from "./shadow-first-draw";
import { firstDrawPipelinesReady, WARM_MAP_PIPELINES_PER_FRAME } from "./shadow-map-warm";
import { webGpuEngine } from "./webgpu-test-fixtures";

beforeEach(() => WebGPUCacheRenderPipelineTree.ResetCache());
afterEach(() => vi.restoreAllMocks());

/** A map awaiting its first draw that renders into render pass `pass`: the members `firstDrawPipelinesReady` reads. */
function awaitingMap(pass: number): ShadowGenerator {
  const generator = { getShadowMap: () => ({ renderPassIds: [pass] }) } as unknown as ShadowGenerator;
  setAwaitingFirstDraw(generator, true);
  return generator;
}

it("starts a frame's warm renders only while its pipeline budget lasts, and renders the next map in the next frame", () => {
  // The real deferral on Babylon's pipeline cache: each warm draw that misses starts its pipeline asynchronously.
  const { engine, draw } = webGpuEngine();
  const scene = { getEngine: () => engine } as unknown as Scene;
  const first = awaitingMap(9);
  const second = awaitingMap(10);
  const rendered: string[] = [];
  // The first map's casters miss as many pipelines as one Engine frame may start.
  const renderFirst = () => {
    rendered.push("first");
    for (let effect = 1; effect <= WARM_MAP_PIPELINES_PER_FRAME; effect++) draw(effect, 9);
  };
  const renderSecond = () => {
    rendered.push("second");
    draw(100, 10);
  };
  const frame = () => [firstDrawPipelinesReady(scene, first, renderFirst), firstDrawPipelinesReady(scene, second, renderSecond)];
  expect(frame()).toEqual([false, false]);
  expect(rendered).toEqual(["first"]);
  engine._frameId += 1;
  // The first map waits for its pipelines without rendering again; the second renders within the new frame's budget.
  expect(frame()).toEqual([false, false]);
  expect(rendered).toEqual(["first", "second"]);
});
