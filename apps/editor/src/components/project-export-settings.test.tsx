import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import { ProjectExportSettings } from "./project-export-settings";

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock());

afterEach(() => cleanup());

/** A Texture as the registry indexes it, with its source size. */
function texture(guid: string, name: string, width: number, height: number): IndexedAsset {
  return { header: { guid, name, type: "Texture", payload: { width, height }, chunks: [], dependencies: [] }, path: `assets/${name}.hasset`, rootId: "project" } as unknown as IndexedAsset;
}

function renderSettings(appId = "", options: { iconTextureGuid?: string | null; assets?: IndexedAsset[] } = {}) {
  const projectDocument = createEmptyProject("Harbour Run");
  projectDocument.settings.appIdentity = { appId, displayName: "", buildNumber: 3, iconTextureGuid: options.iconTextureGuid ?? null };
  const updateProjectSettings = vi.fn();
  const setAppIconPickerOpen = vi.fn();
  const assets = new Map((options.assets ?? []).map((asset) => [asset.header.guid, asset]));
  const assetRegistry = { getByGuid: (guid: string) => assets.get(guid) } as never;
  render(<ProjectExportSettings projectDocument={projectDocument} updateProjectSettings={updateProjectSettings}
    assetRegistry={assetRegistry} setAppIconPickerOpen={setAppIconPickerOpen}
    exportProjectBusy={false} exportProjectError={null} exportNotice={null} handleExport={async () => {}} />);
  return Object.assign(updateProjectSettings, { setAppIconPickerOpen });
}

describe("App Identity", () => {
  it("shows the placeholder App ID and saves an App ID only once it is valid", () => {
    const update = renderSettings();
    const appId = screen.getByTestId("setting-app-id") as HTMLInputElement;
    expect(appId.placeholder).toBe("com.example.harbourrun");

    fireEvent.change(appId, { target: { value: "com.my-studio" } });
    expect(screen.getByText(/Use two or more parts of letters and digits/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(appId, { target: { value: "com.studio.harbour" } });
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "", buildNumber: 3, iconTextureGuid: null } });
    expect(screen.queryByText(/Use two or more parts/)).toBeNull();
  });

  it("saves the display name as typed, with the project name as its placeholder", () => {
    const update = renderSettings("com.studio.harbour");
    const name = screen.getByTestId("setting-app-display-name") as HTMLInputElement;
    expect(name.placeholder).toBe("Harbour Run");
    fireEvent.change(name, { target: { value: "Harbour" } });
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "Harbour", buildNumber: 3, iconTextureGuid: null } });
  });

  it("shows the App Icon Texture and opens the Texture picker", () => {
    const update = renderSettings("", { iconTextureGuid: "tex-icon", assets: [texture("tex-icon", "T_Icon", 1024, 1024)] });
    const button = screen.getByTestId("setting-app-icon");
    expect(button.textContent).toContain("T_Icon");
    expect(button.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(button);
    expect(update.setAppIconPickerOpen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("flags an App Icon packaging would refuse: missing, not square or too small", () => {
    for (const [assets, message] of [
      [[], "The Texture is missing."],
      [[texture("tex-icon", "T_Banner", 2048, 1024)], "The App Icon must be square; this image is 2048 × 1024."],
      [[texture("tex-icon", "T_Small", 512, 512)], "The App Icon must be at least 1024 × 1024; this image is 512 × 512."],
    ] as const) {
      renderSettings("", { iconTextureGuid: "tex-icon", assets: [...assets] });
      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.getByTestId("setting-app-icon").getAttribute("aria-invalid")).toBe("true");
      cleanup();
    }
  });
});
