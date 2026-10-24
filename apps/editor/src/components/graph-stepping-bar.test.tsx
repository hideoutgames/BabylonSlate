import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DebugObserveTarget, DebugStep } from "@haptic/bridge";
import { GraphDebugStore } from "../services/graph-debug-store";
import { GraphSteppingBar } from "./graph-stepping-bar";

const DOOR: DebugObserveTarget = { kind: "class", classId: "Door" };

const tick = (tickIndex: number, stepsTruncated = false) => ({
  target: DOOR, instanceId: "d1", tickIndex, stepsTruncated,
  graphs: [{ assetGuid: "Door.class", graphId: "event-graph", nodes: ["a", "b"], edges: ["e1"], values: [] }],
  steps: [[0, "a", null, []], [0, "b", "e1", []]] as DebugStep[],
});

function renderBar() {
  const store = new GraphDebugStore();
  store.setTarget(DOOR);
  store.receiveRoster({ target: DOOR, reset: true, added: [{ id: "d1", kind: "actor", label: "Front" }], removed: [] });
  store.receiveTrace(tick(7));
  store.setHeld(true);
  const controls = { step: vi.fn(), stepPending: false };
  const onFocus = vi.fn();
  render(<GraphSteppingBar store={store} controls={controls} onFocus={onFocus} />);
  return { store, controls, onFocus };
}

const position = () => screen.getByTestId("graph-step-position").textContent;

afterEach(cleanup);

describe("GraphSteppingBar", () => {
  it("steps back and forward through the recorded visits, opening each and marking the past", () => {
    const { onFocus } = renderBar();
    expect(position()).toBe("Latest Tick");
    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));
    expect(position()).toBe("Tick 7 · Step 2 of 2");
    expect(screen.queryByText("Past")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));
    expect(position()).toBe("Tick 7 · Step 1 of 2");
    expect(screen.getByText("Past")).toBeTruthy();
    expect(onFocus.mock.calls.map(([step]) => step.nodeId)).toEqual(["b", "a"]);
    fireEvent.click(screen.getByRole("button", { name: "Step Forward" }));
    expect(onFocus).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "b", step: 1 }));
  });

  it("has nothing to step back to before a tick is recorded, or past the oldest visit kept", () => {
    const store = new GraphDebugStore();
    store.setTarget(DOOR);
    store.receiveRoster({ target: DOOR, reset: true, added: [{ id: "d1", kind: "actor", label: "Front" }], removed: [] });
    store.setHeld(true);
    render(<GraphSteppingBar store={store} controls={{ step: vi.fn(), stepPending: false }} onFocus={vi.fn()} />);
    expect(position()).toBe("Nothing Recorded Yet");
    expect(screen.getByRole("button", { name: "Step Back" }).hasAttribute("disabled")).toBe(true);
    act(() => store.receiveTrace(tick(1)));
    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));
    expect(position()).toBe("Tick 1 · Step 1 of 2");
    expect(screen.getByRole("button", { name: "Step Back" }).hasAttribute("disabled")).toBe(true);
  });

  it("runs another tick from the newest visit and opens that tick's first visit when it arrives", () => {
    const { store, controls, onFocus } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Step Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Step Forward Into The Next Tick" }));
    expect(controls.step).toHaveBeenCalledOnce();
    act(() => store.receiveTrace(tick(8, true)));
    expect(position()).toBe("Tick 8 · Step 1 of 2");
    expect(onFocus).toHaveBeenLastCalledWith(expect.objectContaining({ tickIndex: 8, nodeId: "a" }));
    // Tick 8's visits stopped at the runtime's limit: its last recorded visit says so.
    expect(screen.queryByText("Later Steps Not Recorded")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Step Forward" }));
    expect(screen.getByText("Later Steps Not Recorded")).toBeTruthy();
  });
});
