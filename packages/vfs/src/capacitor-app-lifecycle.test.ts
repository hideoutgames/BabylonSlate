import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");
const removeListener = vi.fn(() => Promise.resolve());
const addListener = vi.fn<
  (
    eventName: string,
    listener: (state: { isActive: boolean }) => void,
  ) => Promise<{ remove: () => Promise<void> }>
>(() => Promise.resolve({ remove: removeListener }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener },
}));

const { initializeCapacitorLifecycle } = await import(
  "./capacitor-app-lifecycle"
);

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Capacitor app lifecycle bridge", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("ios");
    addListener.mockClear();
    removeListener.mockClear();
  });

  it("registers an appStateChange listener on iOS", async () => {
    initializeCapacitorLifecycle();
    await flushAsync();

    expect(addListener).toHaveBeenCalledWith(
      "appStateChange",
      expect.any(Function),
    );
  });

  it("dispatches babylonslate:appstate with isActive false when the app backgrounds", async () => {
    initializeCapacitorLifecycle();
    await flushAsync();

    const handler = addListener.mock.calls[0][1];
    const listener = vi.fn();
    window.addEventListener("babylonslate:appstate", listener);

    handler({ isActive: false });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { isActive: false },
      }),
    );
  });

  it("dispatches babylonslate:appstate with isActive true when the app foregrounds", async () => {
    initializeCapacitorLifecycle();
    await flushAsync();

    const handler = addListener.mock.calls[0][1];
    const listener = vi.fn();
    window.addEventListener("babylonslate:appstate", listener);

    handler({ isActive: true });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { isActive: true },
      }),
    );
  });

  it("does not register the Capacitor listener on web", async () => {
    getPlatform.mockReturnValue("web");
    initializeCapacitorLifecycle();
    await flushAsync();

    expect(addListener).not.toHaveBeenCalled();
  });

  it("does not register the Capacitor listener in Electron", async () => {
    getPlatform.mockReturnValue("web");
    (globalThis as { babylonslate?: unknown }).babylonslate = { userData: {} };

    initializeCapacitorLifecycle();
    await flushAsync();

    expect(addListener).not.toHaveBeenCalled();
  });

  it("removes the Capacitor listener when the returned cleanup is called", async () => {
    const cleanup = initializeCapacitorLifecycle();
    await flushAsync();

    cleanup();
    await flushAsync();

    expect(removeListener).toHaveBeenCalled();
  });
});
