import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyProject } from "@haptic/core";
import type { EngineSettings } from "@haptic/vfs";
import { EditorExtensionsRuntime } from "./editor-extensions-runtime";

const TRUST_KEY = JSON.stringify(["opfs:Extensions", "project-guid"]);

const harness = vi.hoisted(() => {
  const state = {
    guard: null as ((path: string) => void) | null,
    // Stands in for the document service: tabs open without a render.
    open: [] as Array<{ id: string; ref: { kind: string; path: string } }>,
    calls: [] as unknown[][],
    extensionSettings: {} as Record<string, Record<string, string | number | boolean>>,
    trusted: [] as string[],
    hydrated: true,
    createdHere: false,
    settingsUpdates: [] as string[][],
  };
  return {
    state,
    extensionService: {
      setAssetWriteGuard: (guard: (path: string) => void) => {
        state.guard = guard;
      },
      setSettingValues: (values: unknown) => { state.calls.push(["setSettingValues", values]); },
      refresh: async (overrides: unknown, trusted: unknown) => { state.calls.push(["refresh", overrides, trusted]); },
      close: async () => {},
      projectTrustKey: (guid: string) => JSON.stringify(["opfs:Extensions", guid]),
      createdHere: () => state.createdHere,
      forgetCreatedProject: () => { state.createdHere = false; },
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

vi.mock("../context/app-settings-context", async () => {
  const { defaultEngineSettings: defaults } = await import("@haptic/vfs");
  return {
    useAppSettings: () => ({
      settings: { ...defaults(), trustedProjectExtensions: harness.state.trusted },
      version: 1,
      hydrated: harness.state.hydrated,
      updateSettings: async (mutate: (settings: EngineSettings) => void) => {
        const next = { ...defaults(), trustedProjectExtensions: [...harness.state.trusted] };
        mutate(next);
        harness.state.settingsUpdates.push(next.trustedProjectExtensions);
      },
      updateDebuggerDefaults: async () => {},
    }),
  };
});

afterEach(() => {
  cleanup();
  harness.state.guard = null;
  harness.state.open = [];
  harness.state.calls = [];
  harness.state.extensionSettings = {};
  harness.state.trusted = [];
  harness.state.hydrated = true;
  harness.state.createdHere = false;
  harness.state.settingsUpdates = [];
});

it("hands the project's extension setting values to the service before extensions start", () => {
  harness.state.extensionSettings = { weather: { region: "north" } };
  harness.state.trusted = [TRUST_KEY];
  render(<EditorExtensionsRuntime />);
  expect(harness.state.calls).toEqual([
    ["setSettingValues", { weather: { region: "north" } }],
    ["refresh", {}, true],
  ]);
});

it("starts the project's extensions untrusted unless this computer trusts this project's folder and GUID", () => {
  // Trust recorded for the same GUID in another folder does not carry over.
  harness.state.trusted = [JSON.stringify(["opfs:Copy", "project-guid"])];
  render(<EditorExtensionsRuntime />);
  expect(harness.state.calls.filter((call) => call[0] === "refresh")).toEqual([["refresh", {}, false]]);
  expect(harness.state.settingsUpdates).toEqual([]);
});

it("runs nothing until Engine Settings, which hold the trust, have loaded", () => {
  harness.state.hydrated = false;
  harness.state.trusted = [TRUST_KEY];
  render(<EditorExtensionsRuntime />);
  expect(harness.state.calls.filter((call) => call[0] === "refresh")).toEqual([]);
});

it("trusts a project this editor just created and records it", () => {
  harness.state.createdHere = true;
  render(<EditorExtensionsRuntime />);
  expect(harness.state.calls.filter((call) => call[0] === "refresh")).toEqual([["refresh", {}, true]]);
  expect(harness.state.settingsUpdates).toEqual([[TRUST_KEY]]);
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
