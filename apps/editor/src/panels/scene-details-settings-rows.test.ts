import { describe, expect, it, vi } from "vitest";
import { createDefaultSceneLayer, sceneLayerToEditorScene, type SerializedScene } from "@haptic/core";
import { sceneDetailsSettingsRows } from "./scene-details-settings-rows";

function layerRows(scene: SerializedScene, mutate: (next: SerializedScene) => void) {
  return sceneDetailsSettingsRows({
    scene, projectDocument: null, classEntries: [], pickerAssets: [], mutate,
    setEnvTexturePickOpen: () => {}, setCameraPickerOpen: () => {},
  }).overlaySettingsRows;
}

describe("Scene Layer settings rows", () => {
  it("shows Tick On Pause off by default and writes the layer setting", () => {
    const mutate = vi.fn();
    const scene = sceneLayerToEditorScene(createDefaultSceneLayer());
    const row = layerRows(scene, mutate).find((entry) => entry.id === "scene-layer-tick-on-pause");
    expect(row).toMatchObject({ kind: "boolean", label: "Tick On Pause", value: false, defaultValue: false });
    (row as { onChange: (value: boolean) => void }).onChange(true);
    expect((mutate.mock.calls[0]![0] as SerializedScene).settings.layerTickOnPause).toBe(true);
  });
});
