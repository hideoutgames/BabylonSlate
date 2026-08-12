import { describe, expect, it, vi } from "vitest";
import type { DockWindowDefinition } from "./window-catalog";
import { findDockWindow } from "./window-catalog";
import {
  capturePanelPlacement,
  closeDockWindow,
  isDockWindowOpen,
  openDockWindow,
  toggleDockWindow,
  type DockWindowApi,
  type DockWindowPanel,
} from "./dock-window-ops";

interface GroupBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FakePanelState {
  id: string;
  groupId: string;
  box?: GroupBox;
  width?: number;
  height?: number;
  neighborId?: string;
  neighborDirection?: DockWindowPanel["neighborDirection"];
}

function groupCenter(box: GroupBox): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

function matchesNav(
  from: GroupBox,
  to: GroupBox,
  direction: "left" | "right" | "up" | "down",
): boolean {
  const a = groupCenter(from);
  const b = groupCenter(to);
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (direction === "left") return dx < 0 && Math.abs(dx) >= Math.abs(dy);
  if (direction === "right") return dx > 0 && Math.abs(dx) >= Math.abs(dy);
  if (direction === "up") return dy < 0 && Math.abs(dy) >= Math.abs(dx);
  return dy > 0 && Math.abs(dy) >= Math.abs(dx);
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
    const groupPanels = new Map<string, Array<{ id: string }>>();
    for (const state of states) {
      const list = groupPanels.get(state.groupId) ?? [];
      list.push({ id: state.id });
      groupPanels.set(state.groupId, list);
    }
    for (const state of states) {
      const panel: DockWindowPanel = {
        id: state.id,
        group: {
          id: state.groupId,
          panels: groupPanels.get(state.groupId),
        },
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

  const adjacentGroupInDirection: NonNullable<
    DockWindowApi["adjacentGroupInDirection"]
  > = (group, direction) => {
    const fromState = initial.find((entry) => entry.groupId === group.id);
    if (!fromState?.box) return undefined;
    let best:
      | { id: string; dist: number; panels: Array<{ id: string }> }
      | undefined;
    const seen = new Set<string>();
    for (const state of initial) {
      if (state.groupId === group.id || !state.box || seen.has(state.groupId)) {
        continue;
      }
      seen.add(state.groupId);
      if (!matchesNav(fromState.box, state.box, direction)) continue;
      const a = groupCenter(fromState.box);
      const b = groupCenter(state.box);
      const dist =
        (b.cx - a.cx) * (b.cx - a.cx) + (b.cy - a.cy) * (b.cy - a.cy);
      const groupPanelIds = initial
        .filter((entry) => entry.groupId === state.groupId)
        .map((entry) => ({ id: entry.id }));
      if (!best || dist < best.dist) {
        best = { id: state.groupId, dist, panels: groupPanelIds };
      }
    }
    return best
      ? { id: best.id, panels: best.panels }
      : undefined;
  };

  return {
    added,
    closed,
    getPanel: (id: string) => panels.get(id),
    panels: {
      [Symbol.iterator]: () => panels.values(),
    },
    adjacentGroupInDirection,
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

function sceneDefaultLayout(): FakePanelState[] {
  return [
    {
      id: "scene-outliner",
      groupId: "left",
      box: { x: 0, y: 0, width: 260, height: 640 },
      width: 260,
      height: 640,
    },
    {
      id: "viewport",
      groupId: "center",
      box: { x: 260, y: 0, width: 800, height: 480 },
      width: 800,
      height: 480,
    },
    {
      id: "scene-details",
      groupId: "right",
      box: { x: 1060, y: 0, width: 300, height: 640 },
      width: 300,
      height: 640,
    },
    {
      id: "output-log",
      groupId: "bottom",
      box: { x: 260, y: 480, width: 800, height: 160 },
      width: 800,
      height: 160,
    },
  ];
}

function graphDefaultLayout(): FakePanelState[] {
  return [
    {
      id: "actor-prefab",
      groupId: "left-top",
      box: { x: 0, y: 0, width: 260, height: 320 },
      width: 260,
      height: 320,
    },
    {
      id: "my-class",
      groupId: "left-bottom",
      box: { x: 0, y: 320, width: 260, height: 320 },
      width: 260,
      height: 320,
    },
    {
      id: "graph",
      groupId: "center",
      box: { x: 260, y: 0, width: 800, height: 480 },
      width: 800,
      height: 480,
    },
    {
      id: "prefab-viewport",
      groupId: "center",
      box: { x: 260, y: 0, width: 800, height: 480 },
      width: 800,
      height: 480,
    },
    {
      id: "inspector",
      groupId: "right",
      box: { x: 1060, y: 0, width: 280, height: 640 },
      width: 280,
      height: 640,
    },
    {
      id: "compiler-results",
      groupId: "bottom",
      box: { x: 260, y: 480, width: 800, height: 160 },
      width: 800,
      height: 160,
    },
  ];
}

function addedPosition(api: { added: unknown[] }) {
  return api.added[0] as {
    position: { referencePanel: { id: string }; direction: string };
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

  it("records Scene default splits as addPanel-relative placements", () => {
    const api = createFakeApi(sceneDefaultLayout());
    const outliner = findDockWindow("scene", "scene-outliner");
    const details = findDockWindow("scene", "scene-details");
    const output = findDockWindow("scene", "output-log");
    expect(capturePanelPlacement(api, "scene-outliner", outliner)).toMatchObject(
      {
        referencePanelId: "viewport",
        direction: "left",
      },
    );
    expect(capturePanelPlacement(api, "scene-details", details)).toMatchObject({
      referencePanelId: "viewport",
      direction: "right",
    });
    expect(capturePanelPlacement(api, "output-log", output)).toMatchObject({
      referencePanelId: "viewport",
      direction: "below",
    });
  });

  it("records Graph default splits and keeps Prefab within Graph", () => {
    const api = createFakeApi(graphDefaultLayout());
    expect(
      capturePanelPlacement(
        api,
        "prefab-viewport",
        findDockWindow("graph", "prefab-viewport"),
      ),
    ).toMatchObject({
      referencePanelId: "graph",
      direction: "within",
    });
    expect(
      capturePanelPlacement(
        api,
        "actor-prefab",
        findDockWindow("graph", "actor-prefab"),
      ),
    ).toMatchObject({
      referencePanelId: "graph",
      direction: "left",
    });
    expect(
      capturePanelPlacement(
        api,
        "my-class",
        findDockWindow("graph", "my-class"),
      ),
    ).toMatchObject({
      referencePanelId: "actor-prefab",
      direction: "below",
    });
  });

  it("falls back to the catalog default instead of dumping into the first group", () => {
    const api = createFakeApi([
      { id: "viewport", groupId: "center" },
      {
        id: "scene-outliner",
        groupId: "left",
        width: 260,
        height: 400,
      },
    ]);
    expect(
      capturePanelPlacement(
        api,
        "scene-outliner",
        findDockWindow("scene", "scene-outliner"),
      ),
    ).toEqual({
      referencePanelId: "viewport",
      direction: "left",
      width: 260,
      height: 400,
    });
  });

  it("keeps Output Log below Viewport when a full-height side panel is nearer upward", () => {
    const api = createFakeApi([
      {
        id: "scene-outliner",
        groupId: "left",
        box: { x: 0, y: 0, width: 200, height: 960 },
        width: 200,
        height: 960,
      },
      {
        id: "viewport",
        groupId: "center",
        box: { x: 200, y: 0, width: 400, height: 720 },
        width: 400,
        height: 720,
      },
      {
        id: "scene-details",
        groupId: "right",
        box: { x: 600, y: 0, width: 168, height: 960 },
        width: 168,
        height: 960,
      },
      {
        id: "output-log",
        groupId: "bottom",
        box: { x: 200, y: 720, width: 400, height: 240 },
        width: 400,
        height: 240,
      },
    ]);
    expect(
      capturePanelPlacement(
        api,
        "output-log",
        findDockWindow("scene", "output-log"),
      ),
    ).toMatchObject({
      referencePanelId: "viewport",
      direction: "below",
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

  it("treats a mirrored remembered placement as the catalog default", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    const outliner = findDockWindow("scene", "scene-outliner")!;
    openDockWindow(api, outliner, {
      referencePanelId: "viewport",
      direction: "right",
      width: 260,
    });
    expect(addedPosition(api).position.direction).toBe("left");
    expect(addedPosition(api).position.referencePanel.id).toBe("viewport");
  });

  it("treats a within dump as the catalog split when the catalog is not within", () => {
    const api = createFakeApi([{ id: "viewport", groupId: "center" }]);
    const outliner = findDockWindow("scene", "scene-outliner")!;
    openDockWindow(api, outliner, {
      referencePanelId: "viewport",
      direction: "within",
    });
    expect(addedPosition(api).position.direction).toBe("left");
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

  it("reopens Outliner left of Viewport after capturing geometry", () => {
    const api = createFakeApi(sceneDefaultLayout());
    const outliner = findDockWindow("scene", "scene-outliner")!;
    const closed = toggleDockWindow(api, outliner);
    expect(closed.open).toBe(false);
    expect(closed.placement).toMatchObject({
      referencePanelId: "viewport",
      direction: "left",
    });
    const reopened = toggleDockWindow(api, outliner, closed.placement);
    expect(reopened.open).toBe(true);
    expect(addedPosition(api).position.direction).toBe("left");
    expect(addedPosition(api).position.referencePanel.id).toBe("viewport");
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
