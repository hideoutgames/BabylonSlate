import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PerformanceRecorder } from "@babylonslate/debugger";
import { PerformanceSummary, PerformanceTimeline } from "./diagnostic-results-dialog";

afterEach(cleanup);
function recording() {
  let now = 0;
  const recorder = new PerformanceRecorder({ now: () => now });
  recorder.start({ sessionId: "session", mode: "play", sourceSha: "source", buildId: null, sceneId: "scene", backend: "webgl2",
    renderPath: "frameGraph", runtimeHost: "worker", quality: "low", frameCap: 60, dynamicResolution: false, enabledDiagnostics: [], gpuTiming: "unavailable" });
  for (let index = 0; index < 3; index++) {
    now = index * 20;
    recorder.recordFrame({ frameId: index, tickId: index, sceneGeneration: 1, completedAtMs: now, preparationMs: 1, submissionMs: 2, copyMs: 0.5,
      drawCalls: 8, width: 640, height: 360, resolutionScale: 0.5 });
    recorder.recordTick({ tickId: index, elapsedMs: now, scriptMs: 1, physicsMs: 2, publishMs: 0.25, otherMs: 0 });
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
it("switches timeline populations without conflating frame and runtime clocks", () => {
  render(<PerformanceTimeline profile={recording()} />);
  expect(screen.getByRole("columnheader", { name: "Completed At MS" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Runtime Ticks" }));
  expect(screen.getByRole("columnheader", { name: "Elapsed MS" })).toBeTruthy();
  expect(screen.queryByText("Completed At MS")).toBeNull();
});
