import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import type { SimulationControls } from "../context/simulation-controls-context";
import { SimulationToolbarControls } from "./simulation-toolbar-controls";

afterEach(() => {
  cleanup();
});

function controls(overrides: Partial<SimulationControls> = {}): SimulationControls {
  return {
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

  it("offers Step only while paused, and not while a step is still running", () => {
    renderControls();
    expect(screen.queryByTestId("simulation-step")).toBeNull();
    cleanup();
    const paused = controls({ paused: true });
    renderControls({ controls: paused });
    fireEvent.click(screen.getByTestId("simulation-step"));
    expect(paused.step).toHaveBeenCalledOnce();
    cleanup();
    renderControls({ controls: controls({ paused: true, stepPending: true }) });
    expect((screen.getByTestId("simulation-step") as HTMLButtonElement).disabled).toBe(true);
  });

  it("names where a breakpoint stopped while paused there, and opens the node again", () => {
    const onOpenStop = vi.fn();
    renderControls({ controls: controls({ paused: true }), stoppedAt: "Hero › Event Tick › Print String on First", onOpenStop });
    const stop = screen.getByTestId("simulation-breakpoint-stop");
    expect(stop.getAttribute("aria-label")).toBe("Stopped At Hero › Event Tick › Print String on First");
    fireEvent.click(stop);
    expect(onOpenStop).toHaveBeenCalledOnce();
    cleanup();
    renderControls({ controls: controls({ paused: false }), stoppedAt: "Hero › Event Tick › Print String on First" });
    expect(screen.queryByTestId("simulation-breakpoint-stop")).toBeNull();
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
