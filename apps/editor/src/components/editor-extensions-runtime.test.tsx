import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyProject } from "@haptic/core";
import { EditorExtensionsRuntime } from "./editor-extensions-runtime";

const harness = vi.hoisted(() => {
  const state = {
    guard: null as ((path: string) => void) | null,
    // Stands in for the document service: tabs open without a render.
    open: [] as Array<{ id: string; ref: { kind: string; path: string } }>,
    calls: [] as unknown[][],
    extensionSettings: {} as Record<string, Record<string, string | number | boolean>>,
  };
  return {
    state,
    extensionService: {
      setAssetWriteGuard: (guard: (path: string) => void) => {
        state.guard = guard;
      },
      setSettingValues: (values: unknown) => { state.calls.push(["setSettingValues", values]); },
      refresh: async (overrides: unknown) => { state.calls.push(["refresh", overrides]); },
      close: async () => {},
    },
    getOpenDocuments: () => state.open,
  };
});

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    extensionService: harness.extensionService,
    projectGuid: "project-guid",
    projectDocument: (() => {
      const project = createEmptyProject("Extensions");
      return { ...project, settings: { ...project.settings, extensionSettings: harness.state.extensionSettings } };
    })(),
    openDocuments: [],
    getOpenDocuments: harness.getOpenDocuments,
  })),
);

afterEach(() => {
  cleanup();
  harness.state.guard = null;
  harness.state.open = [];
  harness.state.calls = [];
  harness.state.extensionSettings = {};
});

it("hands the project's extension setting values to the service before extensions start", () => {
  harness.state.extensionSettings = { weather: { region: "north" } };
  render(<EditorExtensionsRuntime />);
  expect(harness.state.calls).toEqual([
    ["setSettingValues", { weather: { region: "north" } }],
    ["refresh", {}],
  ]);
});

it("refuses an Extension write to a document opened after the runtime last rendered", () => {
  render(<EditorExtensionsRuntime />);
  const extensionWrite = (path: string) => harness.state.guard?.(path);
  expect(harness.state.guard).not.toBeNull();
  expect(() => extensionWrite("assets/Hero.class.hasset")).not.toThrow();

  harness.state.open = [
    { id: "graph:assets/Hero.class.hasset", ref: { kind: "graph", path: "assets/Hero.class.hasset" } },
  ];

  expect(() => extensionWrite("assets/Hero.class.hasset")).toThrow(/editor tab/);
  expect(() => extensionWrite("assets/Other.material.hasset")).not.toThrow();
});
