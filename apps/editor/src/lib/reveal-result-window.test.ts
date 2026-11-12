import { describe, expect, it, vi } from "vitest";
import { revealResultWindow, type ResultWindowDock } from "./reveal-result-window";

function dockWith(options: {
  graph?: { groupId: string; visible: boolean };
  maximized?: boolean;
}) {
  const setActive = vi.fn();
  const dock: ResultWindowDock = {
    getPanel: (id) =>
      id === "graph" && options.graph
        ? { group: { id: options.graph.groupId }, api: { isVisible: options.graph.visible, setActive } }
        : undefined,
    hasMaximizedGroup: () => options.maximized ?? false,
  };
  return { dock, setActive };
}

describe("revealResultWindow", () => {
  it.each([
    // A choice uncovers a hidden graph beside the results list.
    { case: "hidden, other group", graph: { groupId: "main", visible: false }, maximized: false, open: false, activated: true },
    // It never covers the list: a graph tabbed with it, or one group filling the dock (phone).
    { case: "hidden, results group", graph: { groupId: "results", visible: false }, maximized: false, open: false, activated: false },
    { case: "hidden, phone layout", graph: { groupId: "main", visible: false }, maximized: true, open: false, activated: false },
    { case: "already showing", graph: { groupId: "main", visible: true }, maximized: false, open: false, activated: false },
    // Open always goes there.
    { case: "Open, results group", graph: { groupId: "results", visible: false }, maximized: false, open: true, activated: true },
    { case: "Open, phone layout", graph: { groupId: "main", visible: false }, maximized: true, open: true, activated: true },
    { case: "Open, already showing", graph: { groupId: "main", visible: true }, maximized: false, open: true, activated: true },
  ])("$case: activates the graph window = $activated", ({ graph, maximized, open, activated }) => {
    const { dock, setActive } = dockWith({ graph, maximized });
    const reopen = vi.fn();
    revealResultWindow({ dock, resultsGroupId: "results", panelId: "graph", open, reopen });
    expect(setActive).toHaveBeenCalledTimes(activated ? 1 : 0);
    expect(reopen).not.toHaveBeenCalled();
  });

  it("reopens a closed window only for Open", () => {
    const { dock } = dockWith({});
    const reopen = vi.fn();
    revealResultWindow({ dock, resultsGroupId: "results", panelId: "graph", open: false, reopen });
    expect(reopen).not.toHaveBeenCalled();
    revealResultWindow({ dock, resultsGroupId: "results", panelId: "graph", open: true, reopen });
    expect(reopen).toHaveBeenCalledWith("graph");
  });
});
