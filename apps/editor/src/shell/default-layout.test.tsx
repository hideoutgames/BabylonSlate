import { describe, expect, it, vi } from "vitest";
import { createDockview } from "dockview-react";
import { createDefaultLayoutForKind } from "./default-layout";

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
});
