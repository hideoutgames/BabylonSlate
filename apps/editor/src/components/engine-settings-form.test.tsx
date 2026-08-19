import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { defaultEngineSettings } from "@babylonslate/vfs";
import { EngineSettingsForm } from "./engine-settings-form";

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

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: { list: () => [] },
    openDocuments: [],
  }),
}));

afterEach(() => {
  cleanup();
});

describe("EngineSettingsForm graph", () => {
  it("shows graph default zoom 0.5", () => {
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="graph"
      />,
    );
    expect(getByTestId("setting-graph-default-zoom")).toHaveProperty(
      "value",
      "0.5",
    );
  });
});

describe("EngineSettingsForm viewport", () => {
  it("defaults post-processing on and reports a toggle", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
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
  });
});

describe("EngineSettingsForm User Interface presets", () => {
  const phone = {
    id: "custom-phone",
    label: "Phone",
    width: 390,
    height: 844,
    safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
  };

  it("lists built-in presets as read-only rows", () => {
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="ui"
      />,
    );
    expect(getByTestId("ui-preset-builtin-desktop-4-3").textContent).toContain(
      "1600",
    );
    expect(getByTestId("ui-preset-builtin-desktop-16-9").textContent).toContain(
      "1920",
    );
    expect(getByTestId("ui-preset-builtin-desktop-21-9").textContent).toContain(
      "2560",
    );
  });

  it("adds a custom preset with default size", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={onChange}
        categoryId="ui"
      />,
    );
    fireEvent.click(getByTestId("ui-preset-add"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const patch = onChange.mock.calls[0]![0] as {
      uiDesignerPresets: Array<{
        id: string;
        label: string;
        width: number;
        height: number;
        safeArea: { left: number; right: number; top: number; bottom: number };
      }>;
    };
    expect(patch.uiDesignerPresets).toHaveLength(1);
    expect(patch.uiDesignerPresets[0]!.id).toMatch(/^custom-/);
    expect(patch.uiDesignerPresets[0]).toMatchObject({
      label: "Custom",
      width: 1280,
      height: 720,
      safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
    });
  });

  it("edits a custom preset label and width", () => {
    const onChange = vi.fn();
    const settings = defaultEngineSettings();
    settings.uiDesignerPresets = [phone];
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={settings}
        onChange={onChange}
        categoryId="ui"
      />,
    );
    fireEvent.change(getByTestId("ui-preset-label-custom-phone"), {
      target: { value: "iPhone" },
    });
    expect(onChange).toHaveBeenCalledWith({
      uiDesignerPresets: [{ ...phone, label: "iPhone" }],
    });
    fireEvent.change(getByTestId("ui-preset-width-custom-phone"), {
      target: { value: "430" },
    });
    expect(onChange).toHaveBeenCalledWith({
      uiDesignerPresets: [{ ...phone, width: 430 }],
    });
  });

  it("removes a custom preset", () => {
    const onChange = vi.fn();
    const settings = defaultEngineSettings();
    settings.uiDesignerPresets = [phone];
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={settings}
        onChange={onChange}
        categoryId="ui"
      />,
    );
    fireEvent.click(getByTestId("ui-preset-remove-custom-phone"));
    expect(onChange).toHaveBeenCalledWith({ uiDesignerPresets: [] });
  });
});

describe("EngineSettingsForm focus", () => {
  it("lists default keep tabs for scene and class", () => {
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="focus"
      />,
    );
    expect(getByTestId("focus-keep-scene-viewport")).toBeTruthy();
    expect(getByTestId("focus-keep-graph-graph")).toBeTruthy();
  });

  it("lists default keep tabs for Material, Script Interface, and User Interface", () => {
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="focus"
      />,
    );
    expect(getByTestId("focus-keep-material-material-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-material-function-material-function-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-script-interface-script-interface-preview")).toBeTruthy();
    expect(getByTestId("focus-keep-ui-ui-design")).toBeTruthy();
    expect(getByTestId("focus-keep-uiLogic-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-anim-graph-anim-graph-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-animGraphObject-anim-object-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-behaviour-tree-behaviour-tree-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-skybox-creator-skybox-creator-preview")).toBeTruthy();
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

  it("does not offer Settings on the User Interface Designer keep list", () => {
    const { getByTestId, queryByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="focus"
      />,
    );
    fireEvent.click(getByTestId("focus-keep-ui-add"));
    expect(queryByTestId("focus-keep-ui-add-ui-settings")).toBeNull();
    expect(getByTestId("focus-keep-ui-add-ui-hierarchy")).toBeTruthy();
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
