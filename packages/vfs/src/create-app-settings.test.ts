import { beforeEach, describe, expect, it, vi } from "vitest";

const isMobile = vi.fn(() => false);

vi.mock("./platform", () => ({
  isMobilePlatform: () => isMobile(),
  getHostPlatform: () => (isMobile() ? "ios" : "web"),
}));

const { createAppSettingsStore } = await import("./create-app-settings");
const { WebAppSettingsStore } = await import("./web-app-settings");
const { PreferencesAppSettingsStore } = await import("./preferences-app-settings");

describe("createAppSettingsStore", () => {
  beforeEach(() => {
    isMobile.mockReturnValue(false);
  });

  it("uses the web store on web hosts", () => {
    expect(createAppSettingsStore()).toBeInstanceOf(WebAppSettingsStore);
  });

  it("uses Preferences on mobile hosts", () => {
    isMobile.mockReturnValue(true);
    expect(createAppSettingsStore()).toBeInstanceOf(PreferencesAppSettingsStore);
  });
});
