import { createEmptyProject } from "@babylonslate/core";
import { describe, expect, it } from "vitest";
import { ProjectSaveState } from "./project-save-state";

describe("project settings save ownership", () => {
  it("keeps a later settings edit dirty when an earlier save completes", () => {
    const state = new ProjectSaveState();
    const initial = createEmptyProject("Project");
    state.reset(initial);
    const first = { ...initial, settings: { ...initial.settings, playFrameCap: 30 } };
    const pending = state.capture(first);
    const latest = { ...first, settings: { ...first.settings, playFrameCap: 60 } };
    state.complete(pending);
    expect(state.isDirty(latest)).toBe(true);
    state.complete(state.capture(latest));
    expect(state.isDirty(latest)).toBe(false);
    // An overlapping older write finishing last also leaves the current settings dirty.
    state.complete(pending);
    expect(state.isDirty(latest)).toBe(true);
  });

  it("keeps version changes dirty until a successful save is acknowledged", () => {
    const state = new ProjectSaveState();
    const initial = createEmptyProject("Project");
    state.reset(initial);
    const edited = { ...initial, metadata: { ...initial.metadata, version: "2.0.0" } };
    state.capture(edited);
    expect(state.isDirty(edited)).toBe(true);
    state.complete(state.capture(edited));
    expect(state.isDirty(edited)).toBe(false);
  });

  it("ignores old completions after load/close while derived registry refreshes remain clean", () => {
    const state = new ProjectSaveState();
    const first = createEmptyProject("First");
    state.reset(first);
    const old = state.capture(first);
    const next = createEmptyProject("Next");
    state.reset(next);
    state.complete(old);
    expect(state.isDirty({ ...next, scenes: ["assets/new.scene.babasset"] })).toBe(false);
    state.reset(null);
    state.complete(old);
    expect(state.isDirty(null)).toBe(false);
  });
});
