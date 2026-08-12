import { describe, expect, it, vi } from "vitest";
import type { DockWindowDefinition } from "./window-catalog";
import {
  capturePanelPlacement,
  closeDockWindow,
  isDockWindowOpen,
  openDockWindow,
  toggleDockWindow,
  type DockWindowApi,
  type DockWindowPanel,
} from "./dock-window-ops";

interface FakePanelState {
  id: string;
  groupId: string;
  width?: number;
  height?: number;
  neighborId?: string;
  neighborDirection?: DockWindowPanel["neighborDirection"];
}

function createFakeApi(initial: FakePanelState[]): DockWindowApi & {
  added: unknown[];
  closed: string[];
} {
  const added: unknown[] = [];
  const closed: string[] = [];
  const panels = new Map<string, DockWindowPanel>();

  const rebuild = (states: FakePanelState[]) => {
    panels.clear();
    for (const state of states) {
      const panel: DockWindowPanel = {
        id: state.id,
        group: { id: state.groupId },
        api: {
          close: () => {
            closed.push(state.id);
            states.splice(
              states.findIndex((entry) => entry.id === state.id),
              1,
            );
            rebuild(states);
          },
          setActive: vi.fn(),
          width: state.width,
          height: state.height,
        },
        neighborId: state.neighborId,
        neighborDirection: state.neighborDirection,
      };
      panels.set(state.id, panel);
    }
  };

  rebuild(initial);

  return {
    added,
    closed,
    getPanel: (id: string) => panels.get(id),
    panels: {
      [Symbol.iterator]: () => panels.values(),
    },
    addPanel: (options) => {
      added.push(options);
      const referenceId =
        typeof options.position?.referencePanel === "object" &&
        options.position.referencePanel &&
        "id" in options.position.referencePanel
          ? String(
              (options.position.referencePanel as { id: string }).id,
            )
          : undefined;
      initial.push({
        id: options.id,
        groupId:
          options.position?.direction === "within" && referenceId
            ? (panels.get(referenceId)?.group?.id ?? options.id)
            : options.id,
        width: options.initialWidth,
        height: options.initialHeight,
        neighborId: referenceId,
        neighborDirection: options.position?.direction,
      });
      rebuild(initial);
      return panels.get(options.id);
    },
  };
}

const outputLog: DockWindowDefinition = {
  id: "output-log",
  component: "output-log",
  title: "Output Log",
  defaultPosition: {
    referencePanelId: "viewport",
    direction: "below",
    initialHeight: 160,
  },
};

describe("isDockWindowOpen", () => {
  it("is true only when the panel exists on the api", () => {
    const api = createFakeApi([
      { id: "viewport", groupId: "center" },
      { id: "output-log", groupId: "bottom" },
    ]);
    expect(isDockWindowOpen(api, "output-log")).toBe(true);
    expect(isDockWindowOpen(api, "scene-outliner")).toBe(false);
  });
});

describe("capturePanelPlacement", () => {
  it("records a same-group sibling as within", () => {
    const api = createFakeApi([
      { id: "graph", groupId: "center", width: 800, height: 400 },
      { id: "prefab-viewport", groupId: "center", width: 800, height: 400 },
    ]);
    expect(capturePanelPlacement(api, "prefab-viewport")).toEqual({
      referencePanelId: "graph",
      direction: "within",
      width: 800,
      height: 400,
    });
  });

  it("records a split neighbor and last size", () => {
    const api = createFakeApi([
      { id: "viewport", groupId: "center" },
      {
        id: "output-log",
        groupId: "bottom",
        width: 900,
        height: 180,
        neighborId: "viewport",
        neighborDirection: "below",
      },
    ]);
    expect(capturePanelPlacement(api, "output-log")).toEqual({
      referencePanelId: "viewport",
      direction: "below",
      width: 900,
      height: 180,
    });
  });
});

describe("openDockWindow", () => {
  it("reopens at the remembered reference panel, direction, and size", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    openDockWindow(api, outputLog, {
      referencePanelId: "viewport",
      direction: "below",
      width: 640,
      height: 220,
    });
    expect(api.added).toHaveLength(1);
    const opened = api.added[0] as {
      id: string;
      component: string;
      title: string;
      position: { referencePanel: { id: string }; direction: string };
      initialWidth: number;
      initialHeight: number;
    };
    expect(opened).toMatchObject({
      id: "output-log",
      component: "output-log",
      title: "Output Log",
      position: { direction: "below" },
      initialWidth: 640,
      initialHeight: 220,
    });
    expect(opened.position.referencePanel.id).toBe("viewport");
    expect(api.getPanel("output-log")?.api.setActive).toHaveBeenCalled();
  });

  it("falls back to the catalog default when the remembered reference is gone", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    openDockWindow(api, outputLog, {
      referencePanelId: "missing-panel",
      direction: "right",
      width: 100,
      height: 100,
    });
    const opened = api.added[0] as {
      position: { referencePanel: { id: string }; direction: string };
      initialHeight: number;
    };
    expect(opened.position.direction).toBe("below");
    expect(opened.position.referencePanel.id).toBe("viewport");
    expect(opened.initialHeight).toBe(160);
  });
});

describe("toggleDockWindow", () => {
  it("closes an open panel after capturing placement", () => {
    const api = createFakeApi([
      { id: "viewport", groupId: "center" },
      {
        id: "output-log",
        groupId: "bottom",
        width: 500,
        height: 140,
        neighborId: "viewport",
        neighborDirection: "below",
      },
    ]);
    const result = toggleDockWindow(api, outputLog);
    expect(result.open).toBe(false);
    expect(result.placement).toEqual({
      referencePanelId: "viewport",
      direction: "below",
      width: 500,
      height: 140,
    });
    expect(api.closed).toEqual(["output-log"]);
    expect(isDockWindowOpen(api, "output-log")).toBe(false);
  });

  it("opens a closed panel using remembered placement", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    const result = toggleDockWindow(api, outputLog, {
      referencePanelId: "viewport",
      direction: "below",
      width: 400,
      height: 200,
    });
    expect(result.open).toBe(true);
    expect(api.added).toHaveLength(1);
    expect(isDockWindowOpen(api, "output-log")).toBe(true);
  });

  it("refuses to close the last remaining panel", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    const viewport: DockWindowDefinition = {
      id: "viewport",
      component: "viewport",
      title: "Viewport",
    };
    const result = toggleDockWindow(api, viewport);
    expect(result.open).toBe(true);
    expect(api.closed).toEqual([]);
    expect(isDockWindowOpen(api, "viewport")).toBe(true);
  });
});

describe("closeDockWindow", () => {
  it("returns null when the panel is already closed", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    expect(closeDockWindow(api, "output-log")).toBeNull();
  });
});
