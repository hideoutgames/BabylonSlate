import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  DOUBLE_TAP_MS,
  DEFAULT_SCRUB_SNAP_STRENGTH,
  doubleTapWindowMs,
  dragArmDelayMs,
  holdDelayMs,
  prefersReducedMotion,
  scrubSnapStrength,
  setGestureTiming,
  setReducedMotion,
  setScrubSnapStrength,
} from "@haptic/editor-kit";
import { MemoryAppSettingsStore } from "../../../../packages/vfs/src/test-support/memory-app-settings";
import type { EngineSettings } from "@haptic/vfs";
import { AppSettingsProvider, useAppSettings } from "./app-settings-context";
import { EditorThemeProvider } from "./theme-context";

vi.mock("../lib/editor-themes", () => ({
  applyEditorTheme: () => {},
  resolveEditorTheme: () => null,
}));

const root = document.documentElement;

const originalMatchMedia = window.matchMedia;

/** A device reduced-motion preference the test can change. */
function stubDeviceReducedMotion(initial: boolean) {
  let matches = initial;
  const query = new EventTarget();
  Object.defineProperty(query, "matches", { get: () => matches });
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    matches = next;
    query.dispatchEvent(new Event("change"));
  };
}

let update: ((patch: Partial<EngineSettings>) => Promise<void>) | undefined;
let hydrated = false;
function Updater() {
  const settings = useAppSettings();
  hydrated = settings.hydrated;
  update = (patch) => settings.updateSettings((next) => Object.assign(next, patch));
  return null;
}

async function renderWith(patch: Partial<EngineSettings>) {
  const store = new MemoryAppSettingsStore();
  await store.update((settings) => Object.assign(settings, patch));
  hydrated = false;
  render(
    <AppSettingsProvider store={store}>
      <EditorThemeProvider>
        <Updater />
      </EditorThemeProvider>
    </AppSettingsProvider>,
  );
  // Accessibility applies once the saved settings have loaded.
  await waitFor(() => expect(hydrated).toBe(true));
}

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  root.style.removeProperty("--touch-target");
  root.style.fontSize = "";
  setReducedMotion(false);
  setGestureTiming({ holdMs: CONTEXT_MENU_LONG_PRESS_MS, doubleTapMs: DOUBLE_TAP_MS });
  setScrubSnapStrength(DEFAULT_SCRUB_SNAP_STRENGTH);
});

describe("EditorThemeProvider accessibility", () => {
  it("applies the saved touch target, text size, gesture timing and snap strength", async () => {
    stubDeviceReducedMotion(false);
    await renderWith({ touchTargetScale: 1.5, textSizePercent: 120, holdTimeMs: 900, doubleTapTimeMs: 600, numberSnapStrength: 3 });
    expect(root.style.getPropertyValue("--touch-target")).toBe("66px");
    expect(root.style.fontSize).toBe("120%");
    expect(holdDelayMs()).toBe(900);
    expect(dragArmDelayMs()).toBe(450);
    expect(doubleTapWindowMs()).toBe(600);
    expect(scrubSnapStrength()).toBe(3);

    // Back to the defaults, the stylesheet tokens apply again.
    await act(() => update!({ touchTargetScale: 1, textSizePercent: 100 }));
    expect(root.style.getPropertyValue("--touch-target")).toBe("");
    expect(root.style.fontSize).toBe("");
  });

  it("follows the device for System and overrides it for On and Off", async () => {
    const setDevice = stubDeviceReducedMotion(false);
    await renderWith({ reduceMotion: "system" });
    expect(prefersReducedMotion()).toBe(false);
    act(() => setDevice(true));
    expect(prefersReducedMotion()).toBe(true);

    await act(() => update!({ reduceMotion: "off" }));
    expect(prefersReducedMotion()).toBe(false);
    // Off ignores later device changes.
    act(() => setDevice(false));
    act(() => setDevice(true));
    expect(prefersReducedMotion()).toBe(false);

    await act(() => update!({ reduceMotion: "on" }));
    expect(prefersReducedMotion()).toBe(true);
  });
});
