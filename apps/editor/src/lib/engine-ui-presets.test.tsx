import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  ENGINE_SETTINGS_STORAGE_KEY,
  defaultEngineSettings,
} from "@babylonslate/vfs";
import type { DevicePreset } from "@babylonslate/ui-runtime";
import { dispatchEngineSettingsChanged } from "./viewport-render-gate";
import {
  resolveDesignerCanvasId,
  useEngineUiDesignerPresets,
} from "./engine-ui-presets";

const phone: DevicePreset = {
  id: "custom-phone",
  label: "Phone",
  width: 390,
  height: 844,
  safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
};

function Probe() {
  const extras = useEngineUiDesignerPresets();
  return (
    <div data-testid="extras">{extras.map((preset) => preset.id).join(",")}</div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("resolveDesignerCanvasId", () => {
  it("keeps Desired and known presets, and falls back when a custom id is gone", () => {
    expect(resolveDesignerCanvasId("desired", [])).toBe("desired");
    expect(resolveDesignerCanvasId("ipad-landscape", [])).toBe("ipad-landscape");
    expect(resolveDesignerCanvasId("custom-phone", [phone])).toBe("custom-phone");
    expect(resolveDesignerCanvasId("custom-gone", [phone])).toBe("ipad-landscape");
  });
});

describe("useEngineUiDesignerPresets", () => {
  it("loads custom presets from Engine Settings", async () => {
    localStorage.setItem(
      ENGINE_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...defaultEngineSettings(),
        uiDesignerPresets: [phone],
      }),
    );
    const { getByTestId } = render(<Probe />);
    await waitFor(() => {
      expect(getByTestId("extras").textContent).toBe("custom-phone");
    });
  });

  it("updates when Engine Settings change", async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => {
      expect(getByTestId("extras").textContent).toBe("");
    });
    dispatchEngineSettingsChanged({
      viewportFrameCap: 60,
      uiDesignerPresets: [phone],
    });
    await waitFor(() => {
      expect(getByTestId("extras").textContent).toBe("custom-phone");
    });
  });
});
