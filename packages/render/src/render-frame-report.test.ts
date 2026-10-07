import { NullEngine, Scene } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphExecuteTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/executeTask";
import { afterEach, expect, it } from "vitest";
import { activeRenderFrameCapture, captureRenderFrame, RenderFrameReportFeed, type RenderFrameReport } from "./render-frame-report";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const graph = new FrameGraph(scene);
  return { engine, scene, graph };
}

it("records actual disabled-task fallback execution separately from graph descriptions and detaches", async () => {
  const { engine, scene, graph } = fixture();
  const calls: string[] = [];
  const first = new FrameGraphExecuteTask("World", graph);
  first.func = () => { calls.push("world"); };
  first.dependencies = new Set([0]);
  const second = new FrameGraphExecuteTask("Post effect", graph);
  second.func = () => { calls.push("effect"); };
  second.funcDisabled = () => { calls.push("fallback"); };
  second.disabled = true;
  graph.addTask(first);
  graph.addTask(second);
  await graph.buildAsync(false);
  const { report } = captureRenderFrame(engine, () =>
    activeRenderFrameCapture(engine)!.frameGraph(scene, graph, 4, () => graph.execute()));
  expect(calls).toEqual(["world", "fallback"]);
  expect(report.graphs).toEqual([{ id: 0, sceneUniqueId: scene.uniqueId, generation: 4 }]);
  expect(report.tasks[1]).toMatchObject({ name: "Post effect", disabled: true,
    passes: [{ name: "Post effect" }], disabledPasses: [{ name: "Post effect_disabled" }] });
  expect(report.stages.filter((stage) => stage.kind === "task")).toMatchObject([
    { name: "World", completed: true, fallbackPasses: false, selectedPasses: ["World"] },
    { name: "Post effect", completed: true, fallbackPasses: true, selectedPasses: ["Post effect_disabled"] },
  ]);
  expect(report.resources).toContainEqual(expect.objectContaining({ graphId: 0, handle: 0,
    width: engine.getRenderWidth(), height: engine.getRenderHeight() }));
  expect(report.stages.every((stage) => stage.submissionMs! >= 0)).toBe(true);
  expect(first.onBeforeTaskExecute.hasObservers()).toBe(false);
  expect(second.onAfterTaskExecute.hasObservers()).toBe(false);
  expect(activeRenderFrameCapture(engine)).toBeUndefined();
  graph.execute();
  expect(calls).toEqual(["world", "fallback", "world", "fallback"]);
  expect(report.stages).toHaveLength(3);
});

it("removes observers and releases the capture slot when native task execution throws", async () => {
  const { engine, scene, graph } = fixture();
  const task = new FrameGraphExecuteTask("Fails", graph);
  task.func = () => { throw new Error("failed draw"); };
  graph.addTask(task);
  await graph.buildAsync(false);
  expect(() => captureRenderFrame(engine, () =>
    activeRenderFrameCapture(engine)!.frameGraph(scene, graph, 1, () => graph.execute())))
    .toThrow("failed draw");
  expect(task.onBeforeTaskExecute.hasObservers()).toBe(false);
  expect(task.onAfterTaskExecute.hasObservers()).toBe(false);
  expect(activeRenderFrameCapture(engine)).toBeUndefined();
  task.func = () => {};
  const { report } = captureRenderFrame(engine, () =>
    activeRenderFrameCapture(engine)!.frameGraph(scene, graph, 1, () => graph.execute()));
  expect(report.stages.every((stage) => stage.completed)).toBe(true);
});

it("bounds retained stages and bytes without truncating game rendering", () => {
  const { engine, scene } = fixture();
  let draws = 0;
  const { report } = captureRenderFrame(engine, () => {
    const capture = activeRenderFrameCapture(engine)!;
    for (let index = 0; index < 1000; index++)
      capture.stage(scene, { name: "large name".repeat(1000), kind: "native" }, () => { draws++; });
  });
  expect(draws).toBe(1000);
  expect(report.complete).toBe(false);
  expect(report.droppedRecords).toBeGreaterThan(0);
  expect(report.stages.length).toBeLessThanOrEqual(256);
  expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(report.byteBudget);
  expect(report.retainedBytes).toBeLessThanOrEqual(report.byteBudget);
});

it("accepts only the active capture's coherent-copy receipt and rejects scene replacement", async () => {
  const { engine, scene } = fixture();
  const report: RenderFrameReport = { ...captureRenderFrame(engine, () => {}).report, frame: {
    renderFrameId: 5, snapshotFrameId: 2, tickId: 2, sceneGeneration: 1,
    viewId: scene.uniqueId, width: 128, height: 128, backend: "unknown",
  } };
  const feed = new RenderFrameReportFeed();
  const cancelled = expect(feed.arm(1)).rejects.toThrow("cancelled");
  const stale = feed.candidate(report);
  feed.cancel();
  await cancelled;
  const next = feed.arm(1);
  feed.complete(stale, 1);
  expect(feed.active).toBe(true);
  const accepted = feed.candidate(report);
  feed.complete(accepted, 1);
  expect(await next).toBe(report);
  expect(feed.active).toBe(false);
  const replaced = expect(feed.arm(1)).rejects.toThrow("scene changed");
  feed.complete(feed.candidate(report), 2);
  await replaced;
  expect(feed.active).toBe(false);
});
