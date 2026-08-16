import { describe, expect, it, vi } from "vitest";
import {
  CLASS_PANEL_INITIAL_HEIGHT,
  CLASS_PANEL_TITLE,
  createDefaultLayoutForKind,
} from "./default-layout";

describe("graph default layout", () => {
  it("titles the class panel Class at about half the left stack", () => {
    expect(CLASS_PANEL_TITLE).toBe("Class");
    expect(CLASS_PANEL_INITIAL_HEIGHT).toBeGreaterThanOrEqual(360);
  });
});

describe("createDefaultLayoutForKind", () => {
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
