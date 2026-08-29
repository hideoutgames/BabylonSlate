import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");
const setStyle = vi.fn(() => Promise.resolve());

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));

vi.mock("@capacitor/status-bar", () => ({
  StatusBar: { setStyle },
  Style: { Dark: "DARK", Light: "LIGHT" },
}));

const { CapacitorStatusBarStyle } = await import(
  "./capacitor-status-bar-style"
);
const { createStatusBarStyle } = await import("./create-status-bar-style");

describe("Capacitor status bar style", () => {
  beforeEach(() => {
    setStyle.mockClear();
  });

  it("maps glyph styles to Capacitor status bar styles", async () => {
    const statusBar = new CapacitorStatusBarStyle();
    await statusBar.setStyle("light");
    await statusBar.setStyle("dark");

    expect(setStyle).toHaveBeenNthCalledWith(1, { style: "DARK" });
    expect(setStyle).toHaveBeenNthCalledWith(2, { style: "LIGHT" });
  });
});

describe("createStatusBarStyle", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("web");
    setStyle.mockClear();
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
  });

  it("does not touch the plugin on web", async () => {
    await createStatusBarStyle().setStyle("light");
    expect(setStyle).not.toHaveBeenCalled();
  });

  it("does not touch the plugin in Electron", async () => {
    getPlatform.mockReturnValue("web");
    (globalThis as { babylonslate?: unknown }).babylonslate = {
      userData: {},
    };

    await createStatusBarStyle().setStyle("dark");
    expect(setStyle).not.toHaveBeenCalled();
  });
});
