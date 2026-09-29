import { describe, expect, it } from "vitest";
import type { EditorCameraSessionState } from "@babylonslate/render";
import { EditorSessionState } from "./editor-session-state";
import type { ParticleModuleId } from "./particle-value-modes";

const orbit: EditorCameraSessionState = {
  pose3d: { target: { x: 3, y: 4, z: 5 }, alpha: 1.2, beta: 0.8, radius: 10 },
  pose2d: null,
};
const topDown: EditorCameraSessionState = {
  pose3d: { target: { x: 0, y: 0, z: 0 }, alpha: 0, beta: 0.1, radius: 30 },
  pose2d: null,
};

describe("EditorSessionState", () => {
  it("keeps graph pan/zoom per document surface", () => {
    const state = new EditorSessionState();
    state.saveGraphViewport("graph:Hero", "event", { x: 12, y: 34, zoom: 0.75 });
    state.saveGraphViewport("graph:Hero", "fn-1", { x: -5, y: 0, zoom: 2 });
    expect(state.loadGraphViewport("graph:Hero", "event")).toEqual({ x: 12, y: 34, zoom: 0.75 });
    expect(state.loadGraphViewport("graph:Hero", "fn-1")).toEqual({ x: -5, y: 0, zoom: 2 });
    expect(state.loadGraphViewport("graph:Hero", "fn-2")).toBeNull();
    expect(state.loadGraphViewport("graph:Villain", "event")).toBeNull();
  });

  it("gives a renamed document its own view state, never a stale entry left at the new id", () => {
    const state = new EditorSessionState();
    state.saveCameraPose("scene:assets/old.scene.babasset", orbit);
    state.saveCameraPose("scene:assets/new.scene.babasset", topDown);
    state.saveGraphViewport("scene:assets/new.scene.babasset", "default", { x: 1, y: 1, zoom: 1 });
    state.saveClosedModules(
      "scene:assets/new.scene.babasset",
      new Set<ParticleModuleId>(["bursts"]),
    );

    state.rekeyDocument("scene:assets/old.scene.babasset", "scene:assets/new.scene.babasset");

    expect(state.loadCameraPose("scene:assets/new.scene.babasset")).toEqual(orbit);
    expect(state.loadGraphViewport("scene:assets/new.scene.babasset", "default")).toBeNull();
    expect(state.loadClosedModules("scene:assets/new.scene.babasset")).toBeNull();
    expect(state.loadCameraPose("scene:assets/old.scene.babasset")).toBeNull();
  });

  it("forwards late writes through consecutive renames to the current id", () => {
    const state = new EditorSessionState();
    state.rekeyDocument("graph:a", "graph:b");
    state.rekeyDocument("graph:b", "graph:c");
    state.saveCameraPose("graph:a", orbit);
    state.saveGraphViewport("graph:b", "event", { x: 7, y: 8, zoom: 1.5 });

    expect(state.loadCameraPose("graph:c")).toEqual(orbit);
    expect(state.loadGraphViewport("graph:c", "event")).toEqual({ x: 7, y: 8, zoom: 1.5 });
    expect(state.loadCameraPose("graph:a")).toBeNull();

    state.rekeyDocument("graph:c", "graph:a");
    state.saveCameraPose("graph:a", topDown);
    expect(state.loadCameraPose("graph:a")).toEqual(topDown);
  });
});
