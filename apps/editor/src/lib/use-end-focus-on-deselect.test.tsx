import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEndFocusOnDeselect } from "./use-end-focus-on-deselect";

function track(initial: { target: string | undefined; selected: readonly string[] }) {
  const end = vi.fn();
  const view = renderHook(
    ({ target, selected }) => useEndFocusOnDeselect(target, selected, end),
    { initialProps: initial },
  );
  return { end, view };
}

describe("useEndFocusOnDeselect", () => {
  it("ends the focus once its target was selected and the selection moves off it", () => {
    const { end, view } = track({ target: "tick", selected: [] });
    // Nothing selected yet: the graph has not applied the focus.
    expect(end).not.toHaveBeenCalled();
    view.rerender({ target: "tick", selected: ["tick"] });
    expect(end).not.toHaveBeenCalled();
    view.rerender({ target: "tick", selected: ["log"] });
    expect(end).toHaveBeenCalledTimes(1);
    view.rerender({ target: "tick", selected: [] });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("keeps the focus while the target stays in a wider selection", () => {
    const { end, view } = track({ target: "tick", selected: ["tick"] });
    view.rerender({ target: "tick", selected: ["tick", "log"] });
    expect(end).not.toHaveBeenCalled();
  });

  it("starts over for a new target, so a cleared and repeated focus is not ended by its old selection", () => {
    const { end, view } = track({ target: "tick", selected: ["tick"] });
    view.rerender({ target: undefined, selected: ["tick"] });
    view.rerender({ target: "log", selected: ["tick"] });
    expect(end).not.toHaveBeenCalled();
    view.rerender({ target: "log", selected: ["log"] });
    view.rerender({ target: "log", selected: [] });
    expect(end).toHaveBeenCalledTimes(1);
  });
});
