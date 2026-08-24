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
    expect(toggle.className).not.toMatch(/min-h-\[var\(--touch-target/);
    expect(toggle.closest("[data-slot='field']")?.querySelector("[data-slot='field-content']")).not.toBeNull();
  });

  it("shows camera speed 8", () => {
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="viewport"
      />,
    );
    expect(getByTestId("setting-fly-speed")).toHaveProperty("value", "8");
  });
});

describe("EngineSettingsForm assets", () => {
  it("shows model import default scale 10", () => {
    const { getByTestId } = render(
      <EngineSettingsForm
        settings={defaultEngineSettings()}
        onChange={() => {}}
        categoryId="assets"
      />,
    );
    expect(getByTestId("setting-model-import-scale")).toHaveProperty(
      "value",
      "10",
    );
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

  it("lists default keep tabs for Material and Script Interface", () => {
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
    expect(getByTestId("focus-keep-anim-graph-anim-graph-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-animGraphObject-anim-object-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-behaviour-tree-behaviour-tree-graph")).toBeTruthy();
    expect(getByTestId("focus-keep-model-model-preview")).toBeTruthy();
    expect(getByTestId("focus-keep-skeleton-skeleton-preview")).toBeTruthy();
    expect(getByTestId("focus-keep-animation-animation-preview")).toBeTruthy();
    expect(getByTestId("focus-keep-skybox-creator-skybox-creator-preview")).toBeTruthy();
    expect(getByTestId("focus-keep-trace-trace-timeline")).toBeTruthy();
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
