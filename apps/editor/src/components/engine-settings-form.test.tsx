import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { defaultEngineSettings } from "@babylonslate/vfs";
import { EngineSettingsForm } from "./engine-settings-form";

afterEach(() => {
  cleanup();
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
