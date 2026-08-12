import { describe, expect, it, vi } from "vitest";
import {
  applyFocusLayout,
  GRAPH_FOCUS_HIDE,
  SCENE_FOCUS_HIDE,
} from "./layout-ops";

function fakeApi(ids: string[]) {
  const panels = new Map(
    ids.map((id) => [
      id,
      {
        api: {
          maximize: vi.fn(),
          close: vi.fn(),
        },
      },
    ]),
  );
  return {
    getPanel: (id: string) => panels.get(id),
    panels,
  };
}

describe("applyFocusLayout", () => {
  it("maximizes the scene viewport when the API exists", () => {
    const api = fakeApi(["viewport", "scene-outliner", "scene-details"]);
    applyFocusLayout("scene", api);
    expect(api.getPanel("viewport")!.api.maximize).toHaveBeenCalled();
    expect(api.getPanel("scene-outliner")!.api.close).not.toHaveBeenCalled();
  });

  it("closes non-viewport scene panels when maximize is missing", () => {
    const api = fakeApi(["viewport", ...SCENE_FOCUS_HIDE]);
    api.getPanel("viewport")!.api.maximize = undefined as never;
    applyFocusLayout("scene", api);
    for (const id of SCENE_FOCUS_HIDE) {
      expect(api.getPanel(id)!.api.close).toHaveBeenCalled();
    }
  });

  it("hides prefab and compiler results on a graph document", () => {
    const api = fakeApi([
      "graph",
      "inspector",
      "my-class",
      "actor-prefab",
      ...GRAPH_FOCUS_HIDE,
    ]);
    applyFocusLayout("graph", api);
    for (const id of GRAPH_FOCUS_HIDE) {
      expect(api.getPanel(id)!.api.close).toHaveBeenCalled();
    }
    expect(api.getPanel("graph")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("inspector")!.api.close).not.toHaveBeenCalled();
  });
});
