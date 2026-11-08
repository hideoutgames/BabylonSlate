import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createExtensionSettings, normalizeExtensionContributions, type ExtensionDescriptor } from "@haptic/assets";
import { extensionAssetTypes } from "../lib/extension-asset-types";
import { ExtensionAssetDetailsPanel } from "./extension-asset-editor";

const DOC = "extension-asset:assets/Rain.hasset";
const weather: ExtensionDescriptor = {
  extensionGuid: "weather", folderName: "weather", folderPath: "extensions/weather", settingsPath: "extensions/weather/extension.json",
  contentPath: "extensions/weather/assets", source: "project", readOnly: false,
  settings: { ...createExtensionSettings("Weather", "weather"), contributes: normalizeExtensionContributions({ assetTypes: [{
    id: "preset", title: "Weather Preset", sections: [
      { id: "sky", title: "Sky", fields: [
        { id: "rain", label: "Rain", type: "number", default: 1 },
        { id: "storms", label: "Storms", type: "toggle" },
      ] },
      { id: "notes", title: "Notes", fields: [{ id: "label", label: "Label", type: "text", default: "Showers" }] },
    ],
  }] }) },
};
const harness = vi.hoisted(() => ({
  applyAssetDocumentChange: vi.fn(async () => true),
  snapshot: { entries: [], commands: [], assetTypes: [] as unknown[], diagnostics: [] },
}));

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "extension-asset:assets/Rain.hasset" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "extension-asset:assets/Rain.hasset", ref: { kind: "extension-asset", path: "assets/Rain.hasset" }, content: { rain: 3, stray: true } }],
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
  assetRegistry: { getByPath: () => ({ header: { type: "extension.weather.preset" } }) } as never,
  extensionService: { subscribe: () => () => {}, getSnapshot: () => harness.snapshot } as never,
})));

const panel = {} as IDockviewPanelProps;
// Base UI checkboxes dispatch PointerEvent, which jsdom lacks.
beforeEach(() => vi.stubGlobal("PointerEvent", MouseEvent));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harness.applyAssetDocumentChange.mockClear();
});

describe("Extension asset Inspector", () => {
  it("shows the type's sections and saves a field's change with every other field's resolved value", () => {
    harness.snapshot = { ...harness.snapshot, assetTypes: extensionAssetTypes([weather]) };
    render(<ExtensionAssetDetailsPanel {...panel} />);

    expect(screen.getByRole("region", { name: "Sky" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Storms" }));

    // `stray` is not a field, so it is dropped; `label` has no stored value, so it takes its default.
    expect(harness.applyAssetDocumentChange).toHaveBeenCalledExactlyOnceWith(DOC, { rain: 3, storms: true, label: "Showers" }, "extension-asset:storms");
  });

  it("leaves the asset untouched while no enabled extension declares its type", () => {
    harness.snapshot = { ...harness.snapshot, assetTypes: [] };
    render(<ExtensionAssetDetailsPanel {...panel} />);

    expect(screen.getByTestId("extension-asset-unavailable").textContent).toContain("Extension Unavailable");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(harness.applyAssetDocumentChange).not.toHaveBeenCalled();
  });
});
