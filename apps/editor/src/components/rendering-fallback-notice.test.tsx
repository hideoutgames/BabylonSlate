import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectEngineSession, ProjectEngineState } from "../lib/project-engine";
import { RenderingFallbackNotice } from "./rendering-fallback-notice";

const REASON = "WebGPU initialization failed: No adapter. Using WebGL2.";
function ready(webGpuFallbackReason?: string): ProjectEngineState {
  const session = { engine: {}, requestedBackend: "webgpu", effectiveBackend: "webgl2" } as unknown as ProjectEngineSession;
  return { phase: "ready", session, ...(webGpuFallbackReason ? { webGpuFallbackReason } : {}) };
}

describe("RenderingFallbackNotice", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the WebGPU fallback reason once per Engine until dismissed", () => {
    const first = ready(REASON);
    const view = render(<RenderingFallbackNotice state={first} />);
    expect(screen.getByRole("status").textContent).toContain(REASON);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    // A republished state for the same Engine stays dismissed.
    view.rerender(<RenderingFallbackNotice state={{ ...first }} />);
    expect(screen.queryByRole("status")).toBeNull();
    // A later Engine that also fell back is announced again.
    view.rerender(<RenderingFallbackNotice state={ready(REASON)} />);
    expect(screen.getByRole("status").textContent).toContain(REASON);
  });

  it("stays hidden without a fallback and dismisses itself after a while", () => {
    vi.useFakeTimers();
    const view = render(<RenderingFallbackNotice state={ready()} />);
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<RenderingFallbackNotice state={{ phase: "failed", session: null, webGpuFallbackReason: REASON }} />);
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<RenderingFallbackNotice state={ready(REASON)} />);
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
