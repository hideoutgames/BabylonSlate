import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PERFORMANCE_TICK_COLUMNS_V1, PerformanceRecorder, type PerformanceProfile } from "@haptic/debugger";
import { serializeRenderFrameReport, type RenderFrameReport } from "@haptic/render";
import { DiagnosticResultsStore } from "../services/diagnostic-results-store";
import DiagnosticResultsDialog, { PerformanceSummary, PerformanceTimeline } from "./diagnostic-results-dialog";

vi.mock("../context/app-settings-context", () => ({ useAppSettings: () => ({ settings: { debuggerDefaults: {} } }) }));

afterEach(cleanup);
/** `frames` samples 10 ms apart, except the ones listed in `slow`, which take 40 ms. */
function recording(frames = 3, slow: readonly number[] = []) {
  let now = 0;
  const recorder = new PerformanceRecorder({ now: () => now });
  recorder.start({ sessionId: "session", mode: "play", sourceSha: "source", buildId: null, sceneId: "scene", backend: "webgl2",
    renderPath: "frameGraph", runtimeHost: "worker", quality: "low", frameCap: 60, dynamicResolution: false, enabledDiagnostics: [], gpuTiming: "unavailable" });
  for (let index = 0; index < frames; index++) {
    now += slow.includes(index) ? 40 : frames === 3 ? 20 : 10;
    recorder.recordFrame({ frameId: index, tickId: index, sceneGeneration: 1, completedAtMs: now, preparationMs: 1, submissionMs: 2, copyMs: 0.5,
      drawCalls: 8, width: 640, height: 360, resolutionScale: 0.5 });
    recorder.recordTick({ tickId: index, elapsedMs: now, scriptMs: 1, physicsMs: 2, publishMs: 0.25, otherMs: 0,
      gameInstanceMs: 0.1, sceneSubsystemsMs: 0, actorsMs: 0.5, componentsMs: 0.2, postPhysicsMs: 0.05, sceneSystemsMs: 0.15 });
  }
  return recorder.stop()!;
}
it("shows separate completed-frame and tick populations with honest unavailable GPU data", () => {
  render(<PerformanceSummary profile={recording()} />);
  expect(screen.getByText(/3 completed frame samples · 3 runtime tick samples/)).toBeTruthy();
  expect(screen.getByText("Completed Game-Frame Interval")).toBeTruthy();
  expect(screen.getByText("Worker Script Phase")).toBeTruthy();
  expect(screen.getByText(/GPU timing: unavailable/)).toBeTruthy();
  expect(screen.getAllByText("20.000").length).toBeGreaterThan(0);
});
/** The same ticks as a version 1 file holds them: script and physics, no phases. */
function versionOne(profile: PerformanceProfile): PerformanceProfile {
  return { ...profile, version: 1, ticks: { columns: PERFORMANCE_TICK_COLUMNS_V1, count: 1, chunks: [Float64Array.of(0, 0, 1, 2, 0.25, 0)] } };
}
it("lists the script phases of a version 2 recording, and none for a version 1 file", () => {
  const { unmount } = render(<PerformanceSummary profile={recording()} />);
  expect(screen.getByText("Actors Phase")).toBeTruthy();
  expect(screen.getByText("Scene Systems Phase")).toBeTruthy();
  expect(screen.getByText("Worker Physics Phase")).toBeTruthy();
  unmount();
  render(<PerformanceSummary profile={versionOne(recording())} />);
  expect(screen.queryByText("Actors Phase")).toBeNull();
  expect(screen.getByText("Worker Script Phase")).toBeTruthy();
});
it("stacks runtime ticks by phase, or by script and physics for a version 1 file", () => {
  const { unmount } = render(<PerformanceTimeline profile={recording()} />);
  fireEvent.click(screen.getByRole("button", { name: "Runtime Ticks" }));
  expect(screen.getByText("Tick Phases")).toBeTruthy();
  expect(screen.getAllByLabelText(/Actors 0\.500 ms · .*Scene Systems 0\.150 ms/)).toHaveLength(3);
  unmount();
  render(<PerformanceTimeline profile={versionOne(recording())} />);
  fireEvent.click(screen.getByRole("button", { name: "Runtime Ticks" }));
  expect(screen.getByText("Script + Physics")).toBeTruthy();
});
it("switches timeline populations without conflating frame and runtime clocks", () => {
  render(<PerformanceTimeline profile={recording()} />);
  expect(screen.getByRole("columnheader", { name: "Completed At MS" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Runtime Ticks" }));
  expect(screen.getByRole("columnheader", { name: "Elapsed MS" })).toBeTruthy();
  expect(screen.queryByText("Completed At MS")).toBeNull();
});
it("selects the next over-budget sample in the table and its details", () => {
  render(<PerformanceTimeline profile={recording(150, [120])} />);
  fireEvent.click(screen.getByLabelText("Next Over Budget"));
  const row = screen.getByText("120", { selector: "button" }).closest('[role="row"]');
  expect(row?.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Sample 120")).toBeTruthy();
});
it("opens an exported frame report again without replacing the recording", async () => {
  const report: RenderFrameReport = {
    version: 1, frame: { renderFrameId: 12, snapshotFrameId: 11, tickId: 40, sceneGeneration: 2, viewId: 1, width: 640, height: 360, backend: "webgl2" },
    graphs: [], tasks: [], resources: [], limitations: [], complete: true, droppedRecords: 0, retainedBytes: 0, byteBudget: 262144,
    stages: [{ id: 0, name: "Main Scene", kind: "frameGraph", sceneUniqueId: 7, startedAtMs: 100, submissionMs: 4, completed: true }],
  };
  const store = new DiagnosticResultsStore();
  store.importResult({ kind: "profile", profile: recording() });
  act(() => store.open());
  render(<DiagnosticResultsDialog store={store} />);
  const text = serializeRenderFrameReport(report);
  const file = new File([text], "frame.babframe.json", { type: "application/json" });
  // jsdom's File has no text().
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(screen.getByLabelText("Open saved result"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(/Frame 12 · Tick 40/)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Summary" }));
  expect(screen.getByText(/3 completed frame samples/)).toBeTruthy();
});
