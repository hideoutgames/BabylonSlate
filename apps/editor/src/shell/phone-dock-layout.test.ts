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
