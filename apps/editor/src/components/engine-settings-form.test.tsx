import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { defaultEngineSettings } from "@babylonslate/vfs";
import { EngineSettingsForm } from "./engine-settings-form";

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: { list: () => [] },
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
      focusKeepPanels: {
        scene: ["viewport"],
        graph: ["graph", "inspector"],
      },
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
      focusKeepPanels: {
        scene: ["viewport"],
        graph: [],
      },
    });
  });
});
