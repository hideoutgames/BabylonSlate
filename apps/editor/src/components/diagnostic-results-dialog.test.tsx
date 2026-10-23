import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PERFORMANCE_TICK_COLUMNS_V1, PerformanceRecorder, type PerformanceProfile } from "@haptic/debugger";
import { serializeRenderFrameReport, type RenderFrameReport } from "@haptic/render";
import { DiagnosticResultsStore } from "../services/diagnostic-results-store";
import DiagnosticResultsDialog, { PerformanceSummary } from "./diagnostic-results-dialog";
import { PerformanceTimeline } from "./performance-timeline";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";

vi.mock("../context/app-settings-context", () => ({ useAppSettings: () => ({ settings: { debuggerDefaults: {} } }) }));

afterEach(cleanup);
/** `frames` samples 10 ms apart, except the ones listed in `slow`, which take 40 ms. */
function recording(frames = 3, slow: readonly number[] = [], memory = false) {
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
    if (memory) recorder.recordMemory({ sampledAtMs: now, textureBytes: (index + 1) * 1024 * 1024, geometryBytes: 1024 * 1024 });
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
it("compares two recordings side by side, marking each percentile that got slower", () => {
  // The baseline's frames are 20 ms apart; this recording has one 40 ms frame, so its median interval is 30 ms.
  render(<PerformanceSummary profile={recording(3, [1])} baseline={{ label: "Recording 1", profile: recording() }} />);
  expect(screen.getByText(/compared with Recording 1/)).toBeTruthy();
  const row = screen.getAllByTestId("profile-compare-row").find((entry) => entry.textContent?.startsWith("Completed Game-Frame Interval"))!;
  expect(row.textContent).toContain("20.000 → 30.000");
  const change = within(row).getByText(/^\+10\.000 · \+50\.0%$/);
  expect(change.className).toContain("text-destructive");
  // No distribution bars while comparing.
  expect(screen.queryByRole("columnheader", { name: "Distribution" })).toBeNull();
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
  const legend = () => screen.getByText(/Ticks are placed on the frames/).parentElement!;
  expect(legend().textContent).toContain("Tick Phases");
  expect(legend().textContent).toContain("Actors");
  expect(legend().textContent).toContain("Scene Systems");
  unmount();
  render(<PerformanceTimeline profile={versionOne(recording())} />);
  expect(legend().textContent).toContain("Script + Physics");
  expect(legend().textContent).not.toContain("Actors");
});
it("shows a frame with the tick it presents, and a tick with the first frame presenting it", () => {
  render(<PerformanceTimeline profile={recording()} />);
  expect(screen.getByRole("columnheader", { name: "Completed At MS" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Tick 0" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Runtime Ticks" }));
  expect(screen.getByRole("columnheader", { name: "Elapsed MS" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Frame 0" })).toBeTruthy();
});
it("plots accounted memory, lists its samples, and says when the browser reported no long tasks", () => {
  render(<PerformanceTimeline profile={recording(3, [], true)} />);
  expect(screen.getByRole("group", { name: /3 memory samples/ })).toBeTruthy();
  expect(screen.getByText(/This browser does not report long tasks/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Memory Samples" }));
  expect(screen.getByRole("columnheader", { name: "Texture Bytes" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Geometry Bytes" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Sample 0" }).textContent).toContain("1048576");
});
describe("on the chart", () => {
  // 300 px over the 60 ms recording: a sample at t ms sits at x = 5t; the Frames track is the top 56 px.
  const at = (time: number) => Math.floor(time / 60 * 100) * 3 + 1.5;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 130));
  });
  afterEach(() => vi.restoreAllMocks());

  it("selects a tapped tick and shows the frame that presents it", () => {
    render(<PerformanceTimeline profile={recording()} />);
    const chart = screen.getByRole("group", { name: /Performance timeline/ });
    act(() => {
      dispatchPointerEvent(chart, "pointerdown", { clientX: at(40), clientY: 80 });
      dispatchPointerEvent(chart, "pointerup", { clientX: at(40), clientY: 80 });
    });
    expect(screen.getByRole("columnheader", { name: "Elapsed MS" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sample 1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Frame 1" })).toBeTruthy();
  });

  it("summarizes a dragged range of every track, until it is cleared", () => {
    render(<PerformanceTimeline profile={recording()} />);
    const chart = screen.getByRole("group", { name: /Performance timeline/ });
    act(() => {
      dispatchPointerEvent(chart, "pointerdown", { clientX: 90, clientY: 20 });
      dispatchPointerEvent(chart, "pointermove", { clientX: 210, clientY: 20 });
      dispatchPointerEvent(chart, "pointerup", { clientX: 210, clientY: 20 });
    });
    const summary = screen.getByRole("status", { name: "Range Summary" });
    // The first frame has no interval yet, so one frame of the two in range is measured.
    expect(summary.textContent).toContain("Frames 1 · Median 20.000 ms");
    expect(summary.textContent).toContain("Ticks 2 · Median 3.000 ms");
    fireEvent.click(screen.getByRole("button", { name: "Clear Range" }));
    expect(screen.queryByRole("status", { name: "Range Summary" })).toBeNull();
  });

  it("plots the metric picked for frames", async () => {
    render(<PerformanceTimeline profile={recording()} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Metric" }));
    const drawCalls = await screen.findByRole("option", { name: "Draw Calls" });
    act(() => {
      dispatchPointerEvent(drawCalls, "pointerdown", { pointerType: "mouse" });
      dispatchPointerEvent(drawCalls, "pointerup", { pointerType: "mouse" });
    });
    fireEvent.click(drawCalls, { detail: 1 });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Metric" }).textContent).toContain("Draw Calls"));
    const chart = screen.getByRole("group", { name: /Performance timeline/ });
    act(() => dispatchPointerEvent(chart, "pointermove", { pointerType: "mouse", clientX: at(40), clientY: 20 }));
    expect(screen.getByRole("tooltip").textContent).toContain("Draw Calls 8");
  });
});
it("selects the next over-budget sample in the table and its details", () => {
  render(<PerformanceTimeline profile={recording(150, [120])} />);
  fireEvent.click(screen.getByLabelText("Next Over Budget"));
  const row = screen.getByText("120", { selector: "button" }).closest('[role="row"]');
  expect(row?.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Sample 120")).toBeTruthy();
});
it("lists script costs by Class and opens an entry's graph at its entry node", async () => {
  const entries = [
    { assetGuid: "Door.class", classId: "Door", className: "Door", exportName: "onTick", event: "onTick", title: "Event Tick", graphId: "event-graph", nodeId: "tick" },
    { assetGuid: "Door.class", classId: "Door", className: "Door", exportName: "evaluate", title: "Transition Rule" },
  ];
  const profile: PerformanceProfile = { ...recording(), scriptEntries: entries,
    scripts: { columns: ["tickId", "entry", "calls", "totalMs"], count: 2, chunks: [Float64Array.of(0, 0, 2, 1.5, 0, 1, 1, 0.5)] } };
  const store = new DiagnosticResultsStore();
  const opened: unknown[] = [];
  store.setSourceOpener(async (location) => { opened.push(location); return "The asset is no longer in the project."; });
  store.importResult({ kind: "profile", profile });
  act(() => store.open());
  render(<DiagnosticResultsDialog store={store} />);
  fireEvent.click(screen.getByRole("button", { name: "Scripts" }));
  expect(screen.getAllByTestId("profile-script-class").map((row) => row.querySelector("th")?.textContent)).toEqual(["Door"]);
  expect(screen.getAllByTestId("profile-script-entry").map((row) => row.querySelector("th")?.textContent)).toEqual(["Event Tick", "Transition Rule"]);
  // An entry recorded without its node has nothing to open.
  expect(screen.queryByRole("button", { name: "Transition Rule" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Event Tick" }));
  expect(opened).toEqual([expect.objectContaining({ assetGuid: "Door.class", graphId: "event-graph", nodeId: "tick" })]);
  await waitFor(() => expect(screen.getByText("The asset is no longer in the project.")).toBeTruthy());
});
it("says a recording made before script costs has none", () => {
  const store = new DiagnosticResultsStore();
  store.importResult({ kind: "profile", profile: { ...recording(), version: 3 } });
  act(() => { store.open(); store.selectView("scripts"); });
  render(<DiagnosticResultsDialog store={store} />);
  expect(screen.getByText("No Script Costs")).toBeTruthy();
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
