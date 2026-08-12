import { describe, expect, it, vi } from "vitest";
import {
  applyFocusLayout,
  focusKeepCandidates,
  migrateRestoredLayout,
  resolveFocusKeepPanelIds,
} from "./layout-ops";
import { listDockWindows } from "./window-catalog";

function fakeApi(ids: string[]) {
  const panelMap = new Map(
    ids.map((id) => [
      id,
      {
        id,
        api: {
          maximize: vi.fn(),
          close: vi.fn(),
          addPanel: vi.fn(),
        },
      },
    ]),
  );
  return {
    getPanel: (id: string) => panelMap.get(id),
    panels: ids.map((id) => panelMap.get(id)!),
    addPanel: vi.fn(),
  };
}

describe("focusKeepCandidates", () => {
  it("lists scene dock tabs that Focus can keep", () => {
    expect(focusKeepCandidates("scene").map((panel) => panel.id)).toEqual(
      listDockWindows("scene").map((entry) => entry.id),
    );
  });

  it("lists class dock tabs that Focus can keep", () => {
    expect(focusKeepCandidates("graph").map((panel) => panel.id)).toEqual(
      listDockWindows("graph").map((entry) => entry.id),
    );
  });
});

describe("resolveFocusKeepPanelIds", () => {
  it("uses the primary surface when the keep list is empty", () => {
    expect(resolveFocusKeepPanelIds("scene", [])).toEqual(["viewport"]);
    expect(resolveFocusKeepPanelIds("graph", undefined)).toEqual(["graph"]);
  });

  it("keeps an explicit list as-is", () => {
    expect(
      resolveFocusKeepPanelIds("graph", ["graph", "inspector"]),
    ).toEqual(["graph", "inspector"]);
  });
});

describe("applyFocusLayout", () => {
  it("closes every open class panel except Graph when keep is graph only", () => {
    const api = fakeApi([
      "graph",
      "inspector",
      "my-class",
      "actor-prefab",
      "prefab-viewport",
      "compiler-results",
    ]);
    applyFocusLayout("graph", api, ["graph"]);
    expect(api.getPanel("graph")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("inspector")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("my-class")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("actor-prefab")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("prefab-viewport")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("compiler-results")!.api.close).toHaveBeenCalled();
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it("does not open a keep-listed panel that is not already in the dock", () => {
    const api = fakeApi(["graph", "my-class"]);
    applyFocusLayout("graph", api, ["graph", "inspector"]);
    expect(api.getPanel("graph")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("my-class")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("inspector")).toBeUndefined();
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it("keeps already-open scene panels that are on the keep list", () => {
    const api = fakeApi([
      "viewport",
      "scene-outliner",
      "scene-details",
      "output-log",
    ]);
    applyFocusLayout("scene", api, ["viewport", "scene-outliner"]);
    expect(api.getPanel("viewport")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("viewport")!.api.maximize).not.toHaveBeenCalled();
    expect(api.getPanel("scene-outliner")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("scene-details")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("output-log")!.api.close).toHaveBeenCalled();
  });
});

describe("migrateRestoredLayout", () => {
  it("closes the retired Assets dock", () => {
    const api = fakeApi(["viewport", "mini-asset-browser", "scene-details"]);
    migrateRestoredLayout(api);
    expect(api.getPanel("mini-asset-browser")!.api.close).toHaveBeenCalled();
  });

  it("moves Class below Components when they share a group", () => {
    const group = { id: "left" };
    const myClass = {
      api: { close: vi.fn(), moveTo: vi.fn() },
      group,
    };
    const components = {
      api: { close: vi.fn(), moveTo: vi.fn() },
      group,
    };
    const api = {
      getPanel: (id: string) => {
        if (id === "my-class") return myClass;
        if (id === "actor-prefab") return components;
        return undefined;
      },
    };
    migrateRestoredLayout(api);
    expect(myClass.api.moveTo).toHaveBeenCalledWith({
      position: "bottom",
      group,
    });
  });
});
