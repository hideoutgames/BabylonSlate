import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import type { SimulationControls } from "../context/simulation-controls-context";
import { DebugStepToolbarControls, SimulationToolbarControls } from "./simulation-toolbar-controls";

afterEach(() => {
  cleanup();
});

function controls(overrides: Partial<SimulationControls> = {}): SimulationControls {
  return {
    mode: "simulate",
    paused: false,
    pausePending: false,
    stepPending: false,
    inputMode: "game",
    inputPending: false,
    keepChanges: false,
    stoppedAt: null,
    togglePause: vi.fn(),
    step: vi.fn(),
    setInputMode: vi.fn(),
    ...overrides,
  };
}

function renderControls(props: Partial<Parameters<typeof SimulationToolbarControls>[0]> = {}) {
  const onStop = vi.fn();
  render(
    <TooltipProvider>
      <SimulationToolbarControls controls={controls()} stopping={false} phone={false} onStop={onStop} {...props} />
    </TooltipProvider>,
  );
  return { onStop };
}

describe("SimulationToolbarControls", () => {
  it("keeps Stop usable while a pause is being acknowledged", () => {
    const { onStop } = renderControls({ controls: controls({ paused: true, pausePending: true }) });
    const pause = screen.getByTestId("simulation-pause") as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(pause.getAttribute("aria-label")).toBe("Resume");
    fireEvent.click(screen.getByTestId("simulation-session-stop"));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("names what Stop does with Simulation changes", () => {
    renderControls({ controls: controls({ keepChanges: true }) });
    expect(screen.getByTestId("simulation-session-stop").getAttribute("aria-label")).toBe("Stop Simulation and Keep Changes");
  });

  it("toggles between Game and Edit input from one button", () => {
    const game = controls();
    renderControls({ controls: game });
    fireEvent.click(screen.getByTestId("simulation-input-mode"));
    expect(game.setInputMode).toHaveBeenCalledWith("edit");
    cleanup();
    const edit = controls({ inputMode: "edit" });
    renderControls({ controls: edit });
    expect(screen.getByTestId("simulation-input-mode").getAttribute("aria-label")).toBe("Edit Input");
    fireEvent.click(screen.getByTestId("simulation-input-mode"));
    expect(edit.setInputMode).toHaveBeenCalledWith("game");
  });

  it("offers Return To Scene only away from the Simulation's Scene", () => {
    renderControls();
    expect(screen.queryByTestId("simulation-return-to-scene")).toBeNull();
    cleanup();
    const onReturnToScene = vi.fn();
    renderControls({ onReturnToScene });
    fireEvent.click(screen.getByTestId("simulation-return-to-scene"));
    expect(onReturnToScene).toHaveBeenCalledOnce();
  });
});

describe("DebugStepToolbarControls", () => {
  const stop = { className: "A Very Long Hero Class Name", entryName: "Event Tick", nodeTitle: "Print String", objectName: "First" };

  function renderDebug(props: Partial<Parameters<typeof DebugStepToolbarControls>[0]> = {}) {
    render(
      <TooltipProvider>
        <DebugStepToolbarControls controls={controls({ paused: true })} stopping={false} onFocusStep={vi.fn()} {...props} />
      </TooltipProvider>,
    );
  }

  it("names the asset a breakpoint stopped in and opens the node from it", () => {
    const onOpenStop = vi.fn();
    renderDebug({ stop, onOpenStop });
    const button = screen.getByTestId("simulation-breakpoint-stop");
    expect(button.textContent).toBe("A Very Long Hero Class Name");
    expect(button.getAttribute("aria-label")).toBe("Stopped At A Very Long Hero Class Name › Event Tick › Print String on First");
    fireEvent.click(button);
    expect(onOpenStop).toHaveBeenCalledOnce();
    cleanup();
    renderDebug();
    expect(screen.queryByTestId("simulation-breakpoint-stop")).toBeNull();
  });

  it("runs one frame from Next Frame, and not while a step is still running", () => {
    const paused = controls({ paused: true });
    renderDebug({ controls: paused });
    fireEvent.click(screen.getByRole("button", { name: "Next Frame" }));
    expect(paused.step).toHaveBeenCalledOnce();
    cleanup();
    renderDebug({ controls: controls({ paused: true, stepPending: true }) });
    expect((screen.getByRole("button", { name: "Next Frame" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
