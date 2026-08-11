import { beforeEach, describe, expect, it, vi } from "vitest";

const isMobile = vi.fn(() => false);
const isElectron = vi.fn(() => false);

vi.mock("./platform", () => ({
  isMobilePlatform: () => isMobile(),
  isElectronHost: () => isElectron(),
  getElectronUserDataBridge: () => null,
  getHostPlatform: () =>
    isMobile() ? "ios" : isElectron() ? "electron" : "web",
}));

const { createAppSettingsStore } = await import("./create-app-settings");
const { WebAppSettingsStore } = await import("./web-app-settings");
const { PreferencesAppSettingsStore } = await import("./preferences-app-settings");
const { ElectronAppSettingsStore } = await import("./electron-app-settings");

describe("createAppSettingsStore", () => {
  beforeEach(() => {
    isMobile.mockReturnValue(false);
    isElectron.mockReturnValue(false);
  });

  it("uses the web store on web hosts", () => {
    expect(createAppSettingsStore()).toBeInstanceOf(WebAppSettingsStore);
  });

  it("uses Preferences on mobile hosts", () => {
    isMobile.mockReturnValue(true);
    expect(createAppSettingsStore()).toBeInstanceOf(PreferencesAppSettingsStore);
  });

  it("uses Electron userData on desktop hosts", () => {
    isElectron.mockReturnValue(true);
    expect(createAppSettingsStore()).toBeInstanceOf(ElectronAppSettingsStore);
  });
});
