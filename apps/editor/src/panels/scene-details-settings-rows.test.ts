import { describe, expect, it, vi } from "vitest";
import { createDefaultScene, createDefaultSceneLayer, sceneLayerToEditorScene, type SerializedScene } from "@haptic/core";
import { sceneDetailsSettingsRows } from "./scene-details-settings-rows";

function layerRows(scene: SerializedScene, mutate: (next: SerializedScene) => void) {
  return sceneDetailsSettingsRows({
    scene, projectDocument: null, classEntries: [], pickerAssets: [], mutate,
    setEnvTexturePickOpen: () => {}, setCameraPickerOpen: () => {},
  }).overlaySettingsRows;
}

function sceneRowIds(scene: SerializedScene, mutate: (next: SerializedScene) => void = () => {}) {
  return sceneDetailsSettingsRows({
    scene, projectDocument: null, classEntries: [], pickerAssets: [], mutate,
    setEnvTexturePickOpen: () => {}, setCameraPickerOpen: () => {},
  }).settingsRows;
}

describe("Scene settings rows", () => {
  it("offers Stack New Actors only in 2D, and Next Z-Order only while it is on", () => {
    const ids = (scene: SerializedScene) => sceneRowIds(scene).map((row) => row.id).filter((id) => id.includes("z-order"));
    expect(ids(createDefaultScene("3d"))).toEqual([]);
    const flat = createDefaultScene("2d");
    expect(ids(flat)).toEqual(["scene-stack-z-order-2d"]);
    expect(ids({ ...flat, settings: { ...flat.settings, stackZOrder2D: true } }))
      .toEqual(["scene-stack-z-order-2d", "scene-next-z-order-2d"]);
  });

  it("writes Next Z-Order as a whole number", () => {
    const mutate = vi.fn();
    const scene = createDefaultScene("2d");
    scene.settings = { ...scene.settings, stackZOrder2D: true };
    const row = sceneRowIds(scene, mutate).find((entry) => entry.id === "scene-next-z-order-2d");
    (row as { onChange: (value: number) => void }).onChange(4.4);
    expect((mutate.mock.calls[0]![0] as SerializedScene).settings.nextZOrder2D).toBe(4);
  });
});

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
