import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorExtensionsRuntime } from "./editor-extensions-runtime";

const harness = vi.hoisted(() => {
  const state = {
    guard: null as ((path: string) => void) | null,
    // Stands in for the document service: tabs open without a render.
    open: [] as Array<{ id: string; ref: { kind: string; path: string } }>,
  };
  return {
    state,
    extensionService: {
      setAssetWriteGuard: (guard: (path: string) => void) => {
        state.guard = guard;
      },
      refresh: async () => {},
      close: async () => {},
    },
    getOpenDocuments: () => state.open,
  };
});

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    extensionService: harness.extensionService,
    projectGuid: "project-guid",
    openDocuments: [],
    getOpenDocuments: harness.getOpenDocuments,
  })),
);

afterEach(() => {
  cleanup();
  harness.state.guard = null;
  harness.state.open = [];
});

it("refuses an Extension write to a document opened after the runtime last rendered", () => {
  render(<EditorExtensionsRuntime />);
  const extensionWrite = (path: string) => harness.state.guard?.(path);
  expect(harness.state.guard).not.toBeNull();
  expect(() => extensionWrite("assets/Hero.class.babasset")).not.toThrow();

  harness.state.open = [
    { id: "graph:assets/Hero.class.babasset", ref: { kind: "graph", path: "assets/Hero.class.babasset" } },
  ];

  expect(() => extensionWrite("assets/Hero.class.babasset")).toThrow(/editor tab/);
  expect(() => extensionWrite("assets/Other.material.babasset")).not.toThrow();
});
