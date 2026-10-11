import { afterEach, describe, expect, it } from "vitest";
import { createDockview, type DockviewApi } from "dockview-react";
import {
  captureAdaptiveDockviewLayout,
  enterPhoneDockLayout,
  isPhoneDockLayout,
  inlineDetachedDockviewLayout,
} from "./phone-dock-layout";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.reverse()) dispose();
  cleanups.length = 0;
});

function createLayout(): DockviewApi {
  const host = document.createElement("div");
  document.body.append(host);
  const api = createDockview(host, {
    createComponent: () => ({
      element: document.createElement("div"),
      init() {},
    }),
  });
  cleanups.push(() => {
    api.dispose();
    host.remove();
  });
  api.layout(1200, 800);
  api.addPanel({ id: "viewport", component: "viewport", title: "Viewport" });
  api.addPanel({
    id: "details",
    component: "details",
    title: "Details",
    position: { referencePanel: "viewport", direction: "right" },
    initialWidth: 300,
  });
  api.getPanel("viewport")!.api.setActive();
  return api;
}

describe("phone Dockview presentation", () => {
  it("shows one active window and follows activation by other editor commands", () => {
    const api = createLayout();
    const phone = enterPhoneDockLayout(api);
    cleanups.push(() => phone.dispose());
    expect(api.getPanel("viewport")!.api.isMaximized()).toBe(true);
    expect(api.getPanel("details")!.api.isVisible).toBe(false);
    api.getPanel("details")!.api.setActive();
    expect(api.getPanel("details")!.api.isMaximized()).toBe(true);
    expect(api.getPanel("viewport")!.api.isVisible).toBe(false);
  });

  it("preserves the desktop arrangement during phone resize and window toggles", () => {
    const api = createLayout();
    const desktop = api.toJSON();
    const viewport = api.getPanel("viewport");
    const phone = enterPhoneDockLayout(api);
    cleanups.push(() => phone.dispose());
    api.layout(390, 700);
    api.getPanel("details")!.api.close();
    expect(isPhoneDockLayout(api)).toBe(true);
    expect(captureAdaptiveDockviewLayout(api)).toEqual(desktop);
    api.layout(1200, 800);
    phone.restore();
    expect(api.hasMaximizedGroup()).toBe(false);
    expect(api.getPanel("viewport")).toBe(viewport);
    expect(api.toJSON()).toEqual(desktop);
    expect(isPhoneDockLayout(api)).toBe(false);
  });

  it("keeps newly opened windows as the only visible phone window", () => {
    const api = createLayout();
    const phone = enterPhoneDockLayout(api);
    cleanups.push(() => phone.dispose());
    api.addPanel({
      id: "output",
      component: "output",
      title: "Output Log",
      position: { referencePanel: "viewport", direction: "below" },
    });
    expect(api.activePanel?.id).toBe("output");
    expect(api.getPanel("output")!.api.isMaximized()).toBe(true);
    expect(api.getPanel("viewport")!.api.isVisible).toBe(false);
  });

  it("docks floating windows for phone use and restores their original placement", () => {
    const api = createLayout();
    api.addFloatingGroup(api.getPanel("details")!);
    const desktop = api.toJSON();
    const phone = enterPhoneDockLayout(api);
    cleanups.push(() => phone.dispose());
    expect(api.getPanel("details")!.api.location.type).toBe("grid");
    api.getPanel("details")!.api.setActive();
    expect(api.getPanel("details")!.api.isMaximized()).toBe(true);
    expect(captureAdaptiveDockviewLayout(api)).toEqual(desktop);
    phone.restore();
    expect(api.getPanel("details")!.api.location.type).toBe("floating");
  });

  it("carries function graph tabs opened or renamed on the phone into the desktop layout", () => {
    const api = createLayout();
    api.addPanel({
      id: "graph",
      component: "graph",
      title: "Event Graph",
      position: { referencePanel: "viewport", direction: "below" },
    });
    api.addPanel({
      id: "function-graph:fn-jump",
      component: "function-graph",
      title: "Jump",
      params: { functionId: "fn-jump" },
      position: { referencePanel: "graph", direction: "within" },
    });
    const phone = enterPhoneDockLayout(api);
    cleanups.push(() => phone.dispose());
    api.getPanel("function-graph:fn-jump")!.api.setTitle("Leap");
    const land = api.addPanel({
      id: "function-graph:fn-land",
      component: "function-graph",
      title: "Land",
      params: { functionId: "fn-land" },
    });
    const saved = captureAdaptiveDockviewLayout(api) as unknown as ReturnType<
      DockviewApi["toJSON"]
    >;
    expect(saved.panels["function-graph:fn-jump"]!.title).toBe("Leap");
    expect(saved.panels["function-graph:fn-land"]).toMatchObject({
      title: "Land",
      params: { functionId: "fn-land" },
    });
    phone.restore();
    expect(api.hasMaximizedGroup()).toBe(false);
    expect(api.getPanel("function-graph:fn-land")).toBe(land);
    expect(land.group.id).toBe(api.getPanel("graph")!.group.id);
    expect(api.getPanel("function-graph:fn-jump")!.title).toBe("Leap");
  });

  it("keeps the splits inside a multi-group floating window when docking it", () => {
    type Layout = ReturnType<DockviewApi["toJSON"]>;
    type GridNode = Layout["grid"]["root"];
    for (const [orientation, stacked] of [
      ["VERTICAL", true],
      ["HORIZONTAL", false],
    ] as const) {
      const api = createLayout();
      const docked = api.toJSON();
      const [viewport, details] = docked.grid.root.data as GridNode[];
      // A floating window holding Details and Output Log in its own split.
      const saved: Layout = {
        ...docked,
        grid: { ...docked.grid, root: { ...docked.grid.root, data: [viewport!] } },
        panels: {
          ...docked.panels,
          output: { id: "output", contentComponent: "output", title: "Output Log" },
        },
        floatingGroups: [
          {
            grid: {
              root: {
                type: "branch",
                data: [
                  { ...details!, size: 200 },
                  {
                    type: "leaf",
                    data: { id: "output-group", views: ["output"], activeView: "output" },
                    size: 200,
                  },
                ],
                size: 400,
              },
              width: 400,
              height: 400,
              orientation,
            },
            position: { left: 10, top: 10, width: 400, height: 400 },
          },
        ],
      };
      api.fromJSON(inlineDetachedDockviewLayout(saved));
      const detailsPanel = api.getPanel("details")!;
      const output = api.getPanel("output")!;
      expect(detailsPanel.api.location.type).toBe("grid");
      expect(output.api.location.type).toBe("grid");
      expect(detailsPanel.group.id).not.toBe(output.group.id);
      if (stacked) {
        expect(output.api.width).toBe(detailsPanel.api.width);
        expect(output.api.height + detailsPanel.api.height).toBeLessThanOrEqual(800);
      } else {
        expect(output.api.height).toBe(800);
        expect(detailsPanel.api.height).toBe(800);
      }
    }
  });

  it("restores saved floating and popout windows inside the mobile host", () => {
    const api = createLayout();
    api.addFloatingGroup(api.getPanel("details")!);
    const saved = api.toJSON();
    const detached = saved.floatingGroups![0]!;
    const popout = {
      ...saved,
      floatingGroups: undefined,
      popoutGroups: [{ data: detached.data, position: null }],
    };
    for (const original of [saved, popout]) {
      const mobile = inlineDetachedDockviewLayout(original);
      expect(mobile.floatingGroups).toBeUndefined();
      expect(mobile.popoutGroups).toBeUndefined();
      api.fromJSON(mobile);
      expect(api.getPanel("details")!.api.location.type).toBe("grid");
      expect(api.getPanel("viewport")!.api.location.type).toBe("grid");
    }
    expect(saved.floatingGroups).toHaveLength(1);
    expect(popout.popoutGroups).toHaveLength(1);
  });
});
