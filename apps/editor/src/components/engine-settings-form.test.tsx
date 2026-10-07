import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { defaultEngineSettings, MemoryAppSettingsStore } from "@babylonslate/vfs";
import { GraphEditor, type GraphDocument } from "@babylonslate/graph-ui";
import { TagProvider } from "@babylonslate/editor-kit";
import { EngineSettingsForm } from "./engine-settings-form";
import { AppSettingsProvider, useAppSettings } from "../context/app-settings-context";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry: { list: () => [] },
  openDocuments: [],
})));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EngineSettingsForm build identity", () => {
  it("lets desktop users turn automatic updates off and back on", () => {
    vi.stubGlobal("babylonslate", { userData: {} });
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="about" />);
    fireEvent.click(view.getByRole("switch", { name: "Automatic Updates" }));
    expect(onChange).toHaveBeenLastCalledWith({ automaticUpdatesEnabled: false });
    view.rerender(<EngineSettingsForm settings={{ ...defaultEngineSettings(), automaticUpdatesEnabled: false }} onChange={onChange} categoryId="about" />);
    fireEvent.click(view.getByRole("switch", { name: "Automatic Updates" }));
    expect(onChange).toHaveBeenLastCalledWith({ automaticUpdatesEnabled: true });
  });

  it("shows the exact channel, version, Apple build and source for support", () => {
    vi.stubGlobal("__BABYLONSLATE_BUILD__", { applicationVersion: "1.2.3", channel: "release", appleBuildNumber: "418.1.1", packageVersion: "1.2.3-release", androidVersionCode: 418101, sourceSha: "a".repeat(40), runNumber: 418, runAttempt: 1 });
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={() => {}} categoryId="about" />);
    expect(view.getByTestId("build-identity").textContent).toContain("Release");
    expect(view.getByTestId("build-identity").textContent).toContain("1.2.3");
    expect(view.getByTestId("build-identity").textContent).toContain("Package 1.2.3-release");
    expect(view.getByTestId("build-identity").textContent).toContain("418.1.1");
    expect(view.getByTestId("build-identity").textContent).toContain("Android 418101");
    expect(view.getByTestId("build-identity").textContent).toContain("a".repeat(40));
    expect(view.getByTestId("build-identity").textContent).not.toContain("TEST");
  });
});

function LiveGraphSettings() {
  const { settings, updateSettings } = useAppSettings();
  return <EngineSettingsForm settings={settings} categoryId="graph"
    onChange={(patch) => updateSettings((next) => { Object.assign(next, patch); })} />;
}

describe("EngineSettingsForm graph", () => {
  it("applies the local pin lock to an open graph and restores editing when disabled", async () => {
    const store = new MemoryAppSettingsStore();
    const onChange = vi.fn();
    const graph: GraphDocument = { nodes: [{
      id: "test", type: "tags.make", position: { x: 0, y: 0 },
      data: { __nodeType: "tags.make", title: "Make Tag", __pins: [
        { id: "value", name: "Value", kind: "data", direction: "in", type: { kind: "tag" } },
      ] },
    }], edges: [] };
    const view = render(<AppSettingsProvider store={store}>
      <LiveGraphSettings />
      <TagProvider entries={[{ id: 8, path: "State", parentId: 0 }]}>
        <GraphEditor initialGraph={graph} onChange={onChange} />
      </TagProvider>
    </AppSettingsProvider>);
    const lock = view.getByRole("switch", { name: "Read-Only Pin Defaults" });
    expect(view.getByTestId("pin-tag-test-value")).toHaveProperty("disabled", false);
    fireEvent.click(lock);
    await waitFor(() => expect(view.getByTestId("pin-tag-test-value")).toHaveProperty("disabled", true));
    expect((await store.load()).readOnlyPinDefaults).toBe(true);
    fireEvent.click(view.getByTestId("pin-tag-test-value"));
    expect(view.queryByRole("dialog", { name: "Select Tag" })).toBeNull();
    fireEvent.click(lock);
    await waitFor(() => expect(view.getByTestId("pin-tag-test-value")).toHaveProperty("disabled", false));
    fireEvent.click(view.getByTestId("pin-tag-test-value"));
    fireEvent.keyDown(view.getByRole("tree", { name: "Tags" }), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ nodes: [expect.objectContaining({
      data: expect.objectContaining({ "default:value": 8 }),
    })] }), expect.anything());
    expect((await store.load()).readOnlyPinDefaults).toBe(false);
  });
});

describe("EngineSettingsForm viewport", () => {
  it("edits the Drop distance through the viewport settings", () => {
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="viewport" />);
    const field = view.getByLabelText("Drop Distance");
    expect(field).toHaveProperty("value", "10000");
    fireEvent.change(field, { target: { value: "25000.5" } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith({ viewportDropDistance: 25000.5 });
  });
  it("reports a post-processing toggle when local overrides are enabled", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={{ ...defaultEngineSettings(), renderingOverridesEnabled: true }}
        onChange={onChange}
        categoryId="viewport"
      />,
    );
    const toggle = getByTestId("setting-post-processing");
    expect(toggle.getAttribute("data-state") ?? toggle.getAttribute("aria-checked")).toMatch(
      /checked|true/,
    );
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ postProcessingEnabled: false });
    expect(toggle.className).not.toMatch(/min-h-\[var\(--touch-target/);
    expect(toggle.closest("[data-slot='field']")?.querySelector("[data-slot='field-content']")).not.toBeNull();
  });
});

describe("EngineSettingsForm assets", () => {
  it("defaults to source textures with optional local LOD and budget controls", () => {
    const { getByTestId, queryByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="assets"
      />,
    );
    const lod = getByTestId("setting-editor-texture-lod");
    expect(lod.getAttribute("data-state") ?? lod.getAttribute("aria-checked")).toMatch(
      /unchecked|false/,
    );
    expect(getByTestId("setting-editor-texture-lod-quality")).toBeTruthy();
    expect(getByTestId("setting-texture-budget-mb")).toHaveProperty("value", "2048");
    expect(getByTestId("setting-audio-budget-mb")).toHaveProperty("value", "256");
    expect(getByTestId("setting-audio-max-voices")).toHaveProperty("value", "32");
    expect(queryByTestId("setting-geometry-budget-mb")).toBeNull();
  });

  it("reports a texture LOD toggle", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={onChange}
        categoryId="assets"
      />,
    );
    fireEvent.click(getByTestId("setting-editor-texture-lod"));
    expect(onChange).toHaveBeenCalledWith({ editorTextureLodEnabled: true });
  });
});

describe("EngineSettingsForm focus", () => {
  it("adds a class tab from the keep dropdown", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={onChange}
        categoryId="focus"
      />,
    );
    fireEvent.click(getByTestId("focus-keep-graph-add"));
    fireEvent.click(getByTestId("focus-keep-graph-add-inspector"));
    expect(onChange).toHaveBeenCalledWith({
      focusKeepPanels: expect.objectContaining({
        graph: ["graph", "inspector"],
      }),
    });
  });

  it("adds a Material Preview tab from the keep dropdown", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={onChange}
        categoryId="focus"
      />,
    );
    fireEvent.click(getByTestId("focus-keep-material-add"));
    fireEvent.click(getByTestId("focus-keep-material-add-material-preview"));
    expect(onChange).toHaveBeenCalledWith({
      focusKeepPanels: expect.objectContaining({
        material: ["material-graph", "material-preview"],
      }),
    });
  });

  it("removes a keep tab", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={onChange}
        categoryId="focus"
      />,
    );
    fireEvent.click(getByTestId("focus-keep-graph-remove-graph"));
    expect(onChange).toHaveBeenCalledWith({
      focusKeepPanels: expect.objectContaining({
        graph: [],
      }),
    });
  });
});
