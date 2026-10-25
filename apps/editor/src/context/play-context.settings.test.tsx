import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultEngineSettings, type AppSettingsStore, type EngineSettings } from "@haptic/vfs";
import { AppSettingsProvider } from "./app-settings-context";
import { PlayProvider, usePlay } from "./play-context";

const host = vi.hoisted(() => ({
  noProject: {
    onSessionDiagnostic: () => () => {},
  } as Record<string, unknown>,
  validation: { setDiagnostics: () => {}, setFocusDiagnostic: () => {} },
}));

vi.mock("./document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => host.noProject));
vi.mock("./validation-context", () => ({ useValidation: () => host.validation }));

afterEach(cleanup);

/** A settings store whose writes finish only when the test releases them, in order. */
function heldStore() {
  let settings: EngineSettings = defaultEngineSettings();
  const pending: Array<() => void> = [];
  const store: AppSettingsStore = {
    load: async () => structuredClone(settings),
    save: async (next) => { settings = structuredClone(next); },
    update: (mutate) => {
      const next = structuredClone(settings);
      mutate(next);
      settings = next;
      const result = structuredClone(next);
      return new Promise((resolve) => pending.push(() => resolve(result)));
    },
  };
  return { store, release: () => pending.shift()?.() };
}

it("keeps a Debug toggle whose saved write is still queued behind another field's write", async () => {
  const held = heldStore();
  let controls!: ReturnType<typeof usePlay>;
  function Consumer() {
    controls = usePlay();
    return null;
  }
  render(
    <AppSettingsProvider store={held.store}>
      <PlayProvider>
        <Consumer />
      </PlayProvider>
    </AppSettingsProvider>,
  );
  await waitFor(() => expect(controls).toBeDefined());
  const statsBefore = controls.overlayStats;
  const consoleBefore = controls.overlayConsole;
  act(() => controls.setOverlayStats(!statsBefore));
  act(() => controls.setOverlayConsole(!consoleBefore));
  // The first write lands; it carries only the Stats change.
  await act(async () => { held.release(); });
  expect(controls.overlayStats).toBe(!statsBefore);
  expect(controls.overlayConsole).toBe(!consoleBefore);
});
