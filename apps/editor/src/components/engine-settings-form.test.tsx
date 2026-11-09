import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { defaultEngineSettings } from "@haptic/vfs";
import { MemoryAppSettingsStore } from "../../../../packages/vfs/src/test-support/memory-app-settings";
import { getAddNodeHistory, GraphEditor, type GraphDocument } from "@haptic/graph-ui";
import { TagProvider } from "@haptic/editor-kit";
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
    vi.stubGlobal("haptic", { userData: {} });
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="about" />);
    fireEvent.click(view.getByRole("switch", { name: "Automatic Updates" }));
    expect(onChange).toHaveBeenLastCalledWith({ automaticUpdatesEnabled: false });
    view.rerender(<EngineSettingsForm settings={{ ...defaultEngineSettings(), automaticUpdatesEnabled: false }} onChange={onChange} categoryId="about" />);
    fireEvent.click(view.getByRole("switch", { name: "Automatic Updates" }));
    expect(onChange).toHaveBeenLastCalledWith({ automaticUpdatesEnabled: true });
  });

  it("shows the exact channel, version, Apple build and source for support", () => {
    vi.stubGlobal("__HAPTIC_BUILD__", { applicationVersion: "1.2.3", channel: "release", appleBuildNumber: "418.1.1", packageVersion: "1.2.3-release", androidVersionCode: 418101, sourceSha: "a".repeat(40), runNumber: 418, runAttempt: 1 });
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

function LiveAccessibilitySettings() {
  const { settings, updateSettings } = useAppSettings();
  return <EngineSettingsForm settings={settings} categoryId="accessibility"
    onChange={(patch) => updateSettings((next) => { Object.assign(next, patch); })} />;
}

describe("EngineSettingsForm accessibility", () => {
  const execPins = [
    { id: "execIn", name: "execIn", kind: "exec", direction: "in", type: { kind: "exec" } },
    { id: "execOut", name: "execOut", kind: "exec", direction: "out", type: { kind: "exec" } },
  ] as const;
  const graph: GraphDocument = {
    nodes: ["a", "b"].map((id, index) => ({
      id, type: "debug.log", position: { x: index * 300, y: 0 },
      data: { title: "Log", __pins: [...execPins] },
    })),
    edges: [],
  };
  const renderLive = (store: MemoryAppSettingsStore, onChange = vi.fn()) => render(<AppSettingsProvider store={store}>
    <LiveAccessibilitySettings />
    <GraphEditor initialGraph={graph} onChange={onChange} />
  </AppSettingsProvider>);
  const tapPin = (view: ReturnType<typeof render>, nodeId: string, pinId: string) =>
    fireEvent.click(view.container.querySelector(`[data-id="${nodeId}"] [data-handleid="${pinId}"]`)!);

  it("connects tapped pins in an open graph only once Tap To Connect Pins is on", async () => {
    const store = new MemoryAppSettingsStore();
    const onChange = vi.fn();
    const view = renderLive(store, onChange);
    const toggle = view.getByRole("switch", { name: "Tap To Connect Pins" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    tapPin(view, "b", "execIn");
    tapPin(view, "a", "execOut");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect((await store.load()).graphTapToConnect).toBe(true);
    tapPin(view, "b", "execIn");
    tapPin(view, "a", "execOut");
    expect((onChange.mock.lastCall?.[0] as GraphDocument).edges).toEqual([
      expect.objectContaining({ source: "a", sourceHandle: "execOut", target: "b", targetHandle: "execIn" }),
    ]);
  });

  it("scales the pins of an open graph with Large Pins, in whole steps from 1× to 4×", async () => {
    const store = new MemoryAppSettingsStore();
    const view = renderLive(store);
    const root = view.getByTestId("graph-editor");
    // jsdom never measures the track, so Base UI keeps the thumb (and its name) hidden.
    const slider = within(view.getByRole("group", { name: "Large Pins" })).getByRole("slider", { hidden: true });
    expect(root.style.getPropertyValue("--graph-pin-scale")).toBe("1");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(() => expect(root.style.getPropertyValue("--graph-pin-scale")).toBe("2"));
    expect(view.getByTestId("setting-large-pins-value").textContent).toBe("2×");
    expect((await store.load()).graphPinScale).toBe(2);
    fireEvent.keyDown(slider, { key: "End" });
    await waitFor(() => expect(root.style.getPropertyValue("--graph-pin-scale")).toBe("4"));
  });
});

describe("EngineSettingsForm Add Node History", () => {
  afterEach(() => getAddNodeHistory().clear());

  it("turns history off without forgetting it, and forgets it only after Clear is confirmed", async () => {
    const history = getAddNodeHistory();
    history.record("pin", "debug.print");
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="graph" />);
    fireEvent.click(view.getByRole("switch", { name: "Add Node History" }));
    expect(onChange).toHaveBeenLastCalledWith({ graphAddNodeHistoryEnabled: false });
    expect(history.isEmpty()).toBe(false);

    const clear = view.getByTestId("setting-graph-add-node-history-clear");
    await waitFor(() => expect(clear).toHaveProperty("disabled", false));
    fireEvent.click(clear);
    expect(history.isEmpty()).toBe(false);
    fireEvent.click(await view.findByTestId("setting-graph-add-node-history-clear-confirm"));
    expect(history.isEmpty()).toBe(true);
    expect(clear).toHaveProperty("disabled", true);
  });
});

describe("EngineSettingsForm undo", () => {
  it("shows the Undo Memory Limit in megabytes and saves it in bytes", () => {
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="undo" />);
    const field = view.getByLabelText("Undo Memory Limit (MB)");
    expect(field).toHaveProperty("value", "16");
    fireEvent.change(field, { target: { value: "48" } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith({ undoByteBudget: 50_331_648 });
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
  it("places on surfaces by default within a 25 unit trace, editable only while it is on", () => {
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="viewport" />);
    const distance = view.getByLabelText("Placement Trace Distance") as HTMLInputElement;
    expect(view.getByTestId("setting-place-on-surfaces").getAttribute("aria-checked")).toBe("true");
    expect(distance.value).toBe("25");
    fireEvent.change(distance, { target: { value: "8" } });
    fireEvent.blur(distance);
    expect(onChange).toHaveBeenCalledWith({ viewportPlacementDistance: 8 });
    fireEvent.click(view.getByTestId("setting-place-on-surfaces"));
    expect(onChange).toHaveBeenCalledWith({ viewportPlaceOnSurfaces: false });
    view.rerender(
      <EngineSettingsForm
        settings={{ ...defaultEngineSettings(), viewportPlaceOnSurfaces: false }}
        onChange={onChange}
        categoryId="viewport"
      />,
    );
    expect((view.getByLabelText("Placement Trace Distance") as HTMLInputElement).disabled).toBe(true);
  });
  it("stacks new 2D actors nowhere by default and writes the chosen hosts", async () => {
    const onChange = vi.fn();
    const view = render(<EngineSettingsForm settings={defaultEngineSettings()} onChange={onChange} categoryId="viewport" />);
    const trigger = view.getByTestId("setting-stack-new-actors-2d");
    expect(trigger.textContent).toContain("Disabled");
    fireEvent.click(trigger);
    const option = await view.findByRole("option", { name: "Scene Layers Only" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ viewportStackNewActors2D: "sceneLayers" }));
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
    // The explanation is the label's tooltip, not text under the row.
    const field = toggle.closest("[data-slot='field']");
    expect(field?.querySelector("[data-slot='field-label'][data-label-hint]")?.textContent).toMatch(/Post-Processing/);
    expect(field?.querySelector("[data-slot='field-description']")).toBeNull();
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

  it("shows viewport Occlusion Culling on by default and reports turning it off", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={onChange}
        categoryId="viewport"
      />,
    );
    const toggle = getByTestId("setting-viewport-occlusion-culling");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ viewportOcclusionCulling: false });
  });
});

describe("EngineSettingsForm focus", () => {
  it("lists every Focus keep-list Engine Settings stores", () => {
    const settings = defaultEngineSettings();
    const { getByTestId } = render(
      <EngineSettingsForm settings={settings} onChange={vi.fn()} categoryId="focus" />,
    );
    for (const [key, ids] of Object.entries(settings.focusKeepPanels)) {
      expect(getByTestId(`focus-keep-${key}-${ids[0]}`)).toBeTruthy();
    }
  });

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
