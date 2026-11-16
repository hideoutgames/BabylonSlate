import { describe, expect, it, vi } from "vitest";
import { createDockview } from "dockview-react";
import { createDefaultLayoutForKind } from "./default-layout";
import { listDockWindows } from "./window-catalog";

describe("createDefaultLayoutForKind", () => {
  it("sizes Sprite Animation Details to 75% of the DockView host", () => {
    const panels = new Map<
      string,
      { id: string; api: { setActive: ReturnType<typeof vi.fn> } }
    >();
    const added: Array<{ id: string; initialWidth?: number }> = [];
    const api = {
      width: 800,
      getPanel: (id: string) => panels.get(id),
      addPanel: (options: { id: string; initialWidth?: number }) => {
        added.push({ id: options.id, initialWidth: options.initialWidth });
        const panel = { id: options.id, api: { setActive: vi.fn() } };
        panels.set(options.id, panel);
        return panel;
      },
    };
    createDefaultLayoutForKind(api as never, "sprite-animation");
    expect(
      added.find((entry) => entry.id === "sprite-animation-details")
        ?.initialWidth,
    ).toBe(600);
  });

  it("sizes Sprite Animation Details once a dock built while hidden is laid out", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const api = createDockview(host, {
      createComponent: () => ({
        element: document.createElement("div"),
        init() {},
      }),
    });
    try {
      // DockviewReact lays a hidden host out at its 0×0 client size.
      api.layout(0, 0);
      createDefaultLayoutForKind(api, "sprite-animation", undefined, 0);
      api.layout(1000, 600);
      await Promise.resolve();
      expect(api.getPanel("sprite-animation-details")!.api.width).toBe(750);
    } finally {
      api.dispose();
      host.remove();
    }
  });

  /** The Integrated Source Control tab's default widths: the stacked Changes, History and Locks; Actors; Diff. */
  async function sourceControlWidths(hidden: boolean): Promise<number[]> {
    const host = document.createElement("div");
    document.body.append(host);
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement("div"), init() {} }),
    });
    try {
      // A tab built while another one is in front lays out at 0×0 first.
      api.layout(hidden ? 0 : 1200, hidden ? 0 : 600);
      createDefaultLayoutForKind(api, "source-control", { sourceControlIntegrated: true }, hidden ? 0 : 1200);
      if (hidden) api.layout(1200, 600);
      await Promise.resolve();
      // Changes, History and Locks stay stacked as tabs of one group.
      expect(api.getPanel("history")!.group).toBe(api.getPanel("changes")!.group);
      expect(api.getPanel("locks")!.group).toBe(api.getPanel("changes")!.group);
      return ["changes", "diff-actors", "diff"].map((id) => api.getPanel(id)!.api.width);
    } finally {
      api.dispose();
      host.remove();
    }
  }

  it("gives the Integrated Source Control tab's stacked windows, Actors and Diff a quarter, a quarter and half of the width", async () => {
    expect(await sourceControlWidths(false)).toEqual([300, 300, 600]);
  });

  it("gives the Source Control tab the same widths when it was built behind another tab", async () => {
    expect(await sourceControlWidths(true)).toEqual([300, 300, 600]);
  });

  it("adds the Behaviour Tree graph before docks that split from it", () => {
    const panels = new Map<
      string,
      { id: string; api: { setActive: ReturnType<typeof vi.fn> } }
    >();
    const added: Array<{
      id: string;
      position?: { referencePanel?: { id: string }; direction?: string };
    }> = [];
    const api = {
      getPanel: (id: string) => panels.get(id),
      addPanel: (options: {
        id: string;
        position?: { referencePanel?: { id: string }; direction?: string };
      }) => {
        added.push({ id: options.id, position: options.position });
        const panel = { id: options.id, api: { setActive: vi.fn() } };
        panels.set(options.id, panel);
        return panel;
      },
    };
    createDefaultLayoutForKind(api as never, "behaviour-tree");
    expect(added.map((entry) => entry.id)[0]).toBe("behaviour-tree-graph");
    const blackboard = added.find(
      (entry) => entry.id === "behaviour-tree-blackboard",
    );
    expect(blackboard?.position?.direction).toBe("left");
    expect(blackboard?.position?.referencePanel?.id).toBe(
      "behaviour-tree-graph",
    );
    expect(panels.get("behaviour-tree-graph")?.api.setActive).toHaveBeenCalled();
  });

  it("leaves Breakpoints out of a new Scene or Class layout, which the Windows menu still lists", () => {
    for (const kind of ["scene", "graph"] as const) {
      const panels = new Map<string, { id: string; api: { setActive: ReturnType<typeof vi.fn> } }>();
      const api = {
        getPanel: (id: string) => panels.get(id),
        addPanel: (options: { id: string }) => {
          const panel = { id: options.id, api: { setActive: vi.fn() } };
          panels.set(options.id, panel);
          return panel;
        },
      };
      createDefaultLayoutForKind(api as never, kind);
      expect(panels.has("compiler-results")).toBe(true);
      expect(panels.has("breakpoints")).toBe(false);
      expect(listDockWindows(kind).some((entry) => entry.id === "breakpoints")).toBe(true);
    }
  });

  it("offers Watches in a Class's Windows menu only, closed in a new layout", () => {
    expect(listDockWindows("graph").some((entry) => entry.id === "watches")).toBe(true);
    expect(listDockWindows("scene").some((entry) => entry.id === "watches")).toBe(false);
    const panels = new Set<string>();
    const api = {
      getPanel: () => undefined,
      addPanel: (options: { id: string }) => {
        panels.add(options.id);
        return { id: options.id, api: { setActive: vi.fn() } };
      },
    };
    createDefaultLayoutForKind(api as never, "graph");
    expect(panels.has("watches")).toBe(false);
  });
});
