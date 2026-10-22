import { expect, it } from "vitest";
import type { RenderFrameReport } from "./render-frame-report";
import { parseRenderFrameReport, serializeRenderFrameReport } from "./render-frame-report-file";

const report: RenderFrameReport = {
  version: 1,
  frame: { renderFrameId: 12, snapshotFrameId: 11, tickId: 40, sceneGeneration: 2, viewId: 1, width: 640, height: 360, backend: "webgl2" },
  graphs: [{ id: 0, sceneUniqueId: 7, generation: 2 }],
  tasks: [{ id: 0, graphId: 0, name: "World", type: "Execute", disabled: false,
    passes: [{ name: "World", disabled: false, colorTargets: [1], depthTarget: 2 }], disabledPasses: [], dependencies: [] }],
  stages: [
    { id: 0, name: "Main Scene", kind: "frameGraph", sceneUniqueId: 7, graphId: 0, startedAtMs: 100, submissionMs: 4.5, drawCalls: 12, completed: true },
    { id: 1, parentId: 0, name: "World", kind: "task", sceneUniqueId: 7, graphId: 0, taskId: 0, startedAtMs: 100.5, submissionMs: 3, completed: true, selectedPasses: ["World"] },
  ],
  resources: [{ graphId: 0, handle: 1, width: 640, height: 360, samples: 1, labels: ["Scene Color"] }],
  complete: true, droppedRecords: 0, retainedBytes: 2048, byteBudget: 262144,
  limitations: ["Stage timings include nested passes and driver waits."],
};

it("reads back an exported frame report", () => {
  expect(parseRenderFrameReport(JSON.parse(serializeRenderFrameReport(report)))).toEqual(report);
});

type Exported = {
  version: number;
  report: Record<string, unknown> & {
    frame: Record<string, unknown>;
    stages: Record<string, unknown>[];
    tasks: { passes: Record<string, unknown>[] }[];
    resources: Record<string, unknown>[];
  };
};
const exported = (change: (copy: Exported) => void) => {
  const value = JSON.parse(serializeRenderFrameReport(report)) as Exported;
  change(value);
  return value;
};
it.each<[string, unknown]>([
  ["a performance profile", { kind: "babylonslate-performance", version: 1 }],
  ["a newer export version", exported((value) => { value.version = 2; })],
  ["a report without stages", exported((value) => { Reflect.deleteProperty(value.report, "stages"); })],
  ["a stage of an unknown kind", exported((value) => { value.report.stages[0]!.kind = "compute"; })],
  ["a stage with a text start time", exported((value) => { value.report.stages[1]!.startedAtMs = "100"; })],
  ["a task pass without a name", exported((value) => { Reflect.deleteProperty(value.report.tasks[0]!.passes[0]!, "name"); })],
  ["an unknown backend", exported((value) => { value.report.frame.backend = "metal"; })],
  ["a resource label that is not text", exported((value) => { value.report.resources[0]!.labels = [3]; })],
  ["something that is not an object", "frame"],
])("rejects %s", (_case, value) => {
  expect(parseRenderFrameReport(value)).toBeNull();
});
