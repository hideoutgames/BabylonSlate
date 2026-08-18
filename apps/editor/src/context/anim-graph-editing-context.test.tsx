import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnimGraphEditingProvider,
  useAnimGraphEditing,
} from "./anim-graph-editing-context";

afterEach(() => {
  cleanup();
});

function Probe() {
  const {
    selectedId,
    selectedTransitionId,
    setSelectedId,
    setSelectedTransitionId,
  } = useAnimGraphEditing();
  return (
    <div>
      <span data-testid="selected-id">{selectedId ?? ""}</span>
      <span data-testid="selected-transition">{selectedTransitionId ?? ""}</span>
      <button type="button" onClick={() => setSelectedId("idle")}>
        select-node
      </button>
      <button type="button" onClick={() => setSelectedTransitionId("t1")}>
        select-transition
      </button>
    </div>
  );
}

describe("AnimGraphEditingProvider", () => {
  it("clears the selected state when a blend rule is selected", () => {
    render(
      <AnimGraphEditingProvider>
        <Probe />
      </AnimGraphEditingProvider>,
    );
    fireEvent.click(screen.getByText("select-node"));
    expect(screen.getByTestId("selected-id").textContent).toBe("idle");
    fireEvent.click(screen.getByText("select-transition"));
    expect(screen.getByTestId("selected-transition").textContent).toBe("t1");
    expect(screen.getByTestId("selected-id").textContent).toBe("");
  });
});
