import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TracePayload } from "@babylonslate/debugger";
import { TracePlayback } from "./trace-playback";

const payload: TracePayload = {
  seed: 7,
  dt: 1 / 60,
  frames: [
    {
      tickIndex: 1,
      scriptMs: 1,
      physicsMs: 0.5,
      logs: [{ severity: "log", category: "game", message: "first" }],
      prints: [{ message: "print-a", key: "a" }],
      snapshotText: "tick=1",
    },
    {
      tickIndex: 2,
      scriptMs: 1.2,
      physicsMs: 0.4,
      logs: [{ severity: "log", category: "game", message: "second" }],
      prints: [],
      snapshotText: "tick=2",
    },
  ],
};

describe("TracePlayback", () => {
  it("opens complete trace log text for selection and copying", () => {
    render(<TracePlayback payload={payload} />);
    fireEvent.click(screen.getAllByTestId("trace-playback-log-line")[0]!);
    const details = within(screen.getByRole("region", { name: "Log Details" }));
    expect(details.getByText(/first/)).toBeTruthy();
    expect(details.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
  it("exposes timing and selected state for an over-budget frame", () => {
    render(<TracePlayback payload={{ ...payload, frames: [{ ...payload.frames[0]!, scriptMs: 20, physicsMs: 2 }] }} />);
    const bar = screen.getByRole("button", { name: /Frame 0.*22.00 ms/ });
    expect(bar.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("trace-frame-timing").textContent).toContain("22.00 ms");
    expect(screen.getByTestId("trace-frame-timing").textContent).toContain("Over Budget");
  });
  afterEach(() => {
    cleanup();
  });

  it("shows seed and scrubs to a recorded snapshot", () => {
    render(<TracePlayback payload={payload} />);
    expect(screen.getByTestId("trace-playback-seed").textContent).toContain("7");
    expect(screen.getByTestId("trace-playback-scrubber")).toBeTruthy();
    expect(screen.getByTestId("trace-playback-graph-bar-0")).toBeTruthy();
    expect(screen.getByTestId("trace-playback-graph-bar-1")).toBeTruthy();
    expect(screen.getByTestId("trace-playback-snapshot").textContent).toContain(
      "tick=2",
    );
    expect(screen.getByTestId("trace-playback-log").textContent).toContain(
      "first",
    );
    expect(screen.getByTestId("trace-playback-log").textContent).toContain(
      "print-a",
    );
    expect(screen.getByTestId("trace-playback-log").textContent).toContain(
      "second",
    );
    fireEvent.click(screen.getByTestId("trace-playback-graph-bar-0"));
    expect(screen.getByTestId("trace-playback-snapshot").textContent).toContain(
      "tick=1",
    );
    fireEvent.change(screen.getByTestId("trace-playback-frame"), {
      target: { value: "0" },
    });
    expect(screen.getByTestId("trace-playback-snapshot").textContent).toContain(
      "tick=1",
    );
    expect(screen.getByTestId("trace-playback-log").textContent).toContain(
      "first",
    );
  });
});
