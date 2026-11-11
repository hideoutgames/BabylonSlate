import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyProject } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import { ProjectExportSettings } from "./project-export-settings";

// Base UI dispatches PointerEvent when activating its native switch input.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const context = vi.hoisted(() => ({ assets: new Map<string, unknown>(), chunkReads: [] as string[] }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry: { getByGuid: (guid: string) => context.assets.get(guid), listRoots: () => [] },
  readAssetChunk: async (path: string, chunkId: string) => {
    context.chunkReads.push(`${path}#${chunkId}`);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  },
}) as never));
// Canvas drawing is the browser's: the preview is whatever it draws from the source.
vi.mock("../lib/app-icon", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/app-icon")>(),
  renderAppIconPreview: async (source: Blob) => source,
}));

const urls = vi.hoisted(() => ({ created: 0, revoked: [] as string[] }));
beforeEach(() => {
  urls.created = 0;
  urls.revoked = [];
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:icon-${++urls.created}`,
    revokeObjectURL: (url: string) => { urls.revoked.push(url); },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  context.assets.clear();
  context.chunkReads = [];
});

/** A Texture as the registry indexes it, with its source size and source pixels chunk. */
function texture(guid: string, name: string, width: number, height: number): IndexedAsset {
  return { header: { guid, name, type: "Texture", payload: { width, height }, chunks: [{ id: "pixels", kind: "pixels", mime: "image/png" }], dependencies: [] }, path: `assets/${name}.hasset`, rootId: "project" } as unknown as IndexedAsset;
}

function renderSettings(appId = "", options: { iconTextureGuid?: string | null; assets?: IndexedAsset[]; autoIncrementBuildNumber?: boolean } = {}) {
  const projectDocument = createEmptyProject("Harbour Run");
  projectDocument.settings.appIdentity = {
    appId, displayName: "", buildNumber: 3, autoIncrementBuildNumber: options.autoIncrementBuildNumber ?? false, iconTextureGuid: options.iconTextureGuid ?? null,
  };
  const updateProjectSettings = vi.fn();
  const updateProjectVersion = vi.fn();
  const setAppIconPickerOpen = vi.fn();
  for (const asset of options.assets ?? []) context.assets.set(asset.header.guid, asset);
  const assetRegistry = { getByGuid: (guid: string) => context.assets.get(guid) } as never;
  render(<ProjectExportSettings projectDocument={projectDocument} updateProjectSettings={updateProjectSettings}
    updateProjectVersion={updateProjectVersion} assetRegistry={assetRegistry} setAppIconPickerOpen={setAppIconPickerOpen}
    exportProjectBusy={false} exportProjectError={null} exportNotice={null} handleExport={async () => {}} />);
  return Object.assign(updateProjectSettings, { setAppIconPickerOpen, updateProjectVersion });
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
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "", buildNumber: 3, autoIncrementBuildNumber: false, iconTextureGuid: null } });
    expect(screen.queryByText(/Use two or more parts/)).toBeNull();
  });

  it("saves the display name as typed, with the project name as its placeholder", () => {
    const update = renderSettings("com.studio.harbour");
    const name = screen.getByTestId("setting-app-display-name") as HTMLInputElement;
    expect(name.placeholder).toBe("Harbour Run");
    fireEvent.change(name, { target: { value: "Harbour" } });
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "Harbour", buildNumber: 3, autoIncrementBuildNumber: false, iconTextureGuid: null } });
  });

  it("edits the Project Version under Display Name", () => {
    const update = renderSettings("com.studio.harbour");
    const rows = [...document.querySelectorAll("[data-testid^='setting'], [data-testid='settings-project-version']")]
      .map((element) => element.getAttribute("data-testid"));
    expect(rows.indexOf("settings-project-version")).toBe(rows.indexOf("setting-app-display-name") + 1);
    const version = screen.getByTestId("settings-project-version") as HTMLInputElement;
    expect(version.value).toBe("1.0.0");
    fireEvent.change(version, { target: { value: "1.2.0" } });
    expect(update.updateProjectVersion).toHaveBeenCalledWith("1.2.0");
  });

  it("turns on Auto Increment Build Number, which locks the Build Number field", () => {
    const update = renderSettings("com.studio.harbour");
    const buildNumber = screen.getByTestId("setting-app-build-number").querySelector("input") ?? screen.getByTestId("setting-app-build-number");
    expect((buildNumber as HTMLInputElement).disabled).toBe(false);
    const toggle = screen.getByRole("switch", { name: "Auto Increment Build Number" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "", buildNumber: 3, autoIncrementBuildNumber: true, iconTextureGuid: null } });
    cleanup();

    renderSettings("com.studio.harbour", { autoIncrementBuildNumber: true });
    const locked = screen.getByTestId("setting-app-build-number").querySelector("input") ?? screen.getByTestId("setting-app-build-number");
    expect((locked as HTMLInputElement).disabled).toBe(true);
    expect((locked as HTMLInputElement).value).toBe("3");
    expect(screen.getByRole("switch", { name: "Auto Increment Build Number" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the App Icon Texture and opens the Texture picker", () => {
    const update = renderSettings("", { iconTextureGuid: "tex-icon", assets: [texture("tex-icon", "T_Icon", 1024, 1024)] });
    const button = screen.getByTestId("setting-app-icon");
    expect(button.textContent).toContain("T_Icon");
    expect(button.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(button);
    expect(update.setAppIconPickerOpen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("refuses only a missing App Icon Texture, and notes one packaging crops or scales up", () => {
    renderSettings("", { iconTextureGuid: "tex-icon" });
    expect(screen.getByText("The Texture is missing.")).toBeTruthy();
    expect(screen.getByTestId("setting-app-icon").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByTestId("app-icon-previews")).toBeNull();
    cleanup();
    for (const [asset, note] of [
      [texture("tex-icon", "T_Banner", 2048, 1024), "This image is 2048 × 1024. The centre 1024 × 1024 is used."],
      [texture("tex-icon", "T_Small", 512, 512), "This image is 512 × 512. Icons up to 1024 × 1024 are scaled up and may look soft."],
    ] as const) {
      renderSettings("", { iconTextureGuid: "tex-icon", assets: [asset] });
      expect(screen.getByTestId("setting-app-icon-hint").textContent).toBe(note);
      expect(screen.getByTestId("setting-app-icon").getAttribute("aria-invalid")).toBeNull();
      cleanup();
    }
  });

  it("previews the App Icon from the Texture's source pixels on every platform", async () => {
    renderSettings("", { iconTextureGuid: "tex-icon", assets: [texture("tex-icon", "T_Icon", 1024, 1024)] });
    const previews = await screen.findByTestId("app-icon-previews");
    expect(context.chunkReads).toEqual(["assets/T_Icon.hasset#pixels"]);
    for (const platform of ["ios", "android", "desktop", "web"]) {
      expect(screen.getByTestId(`app-icon-preview-${platform}`).querySelector("img")!.getAttribute("src")).toBe("blob:icon-1");
    }
    expect(previews.querySelector('[data-shape="ios"]')).toBeTruthy();
    expect(previews.querySelector('[data-shape="android"]')).toBeTruthy();
    // The web tab carries the app's name: the project's, until a Display Name is set.
    expect(screen.getByTestId("app-icon-preview-web").textContent).toContain("Harbour Run");
    cleanup();
    await waitFor(() => expect(urls.revoked).toEqual(["blob:icon-1"]));
  });

  it("shows no preview without an App Icon", () => {
    renderSettings();
    expect(screen.queryByTestId("app-icon-previews")).toBeNull();
    expect(screen.queryByTestId("setting-app-icon-hint")).toBeNull();
  });
});
