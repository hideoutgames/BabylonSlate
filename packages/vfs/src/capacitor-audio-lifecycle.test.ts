import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const getPlatform = vi.fn(() => "web");
const removeInterruption = vi.fn(() => Promise.resolve());
const removeRouteChange = vi.fn(() => Promise.resolve());
const addListener = vi.fn((eventName: string) =>
  Promise.resolve({
    remove:
      eventName === "audioInterruption" ? removeInterruption : removeRouteChange,
  }),
) as unknown as Mock<
  [eventName: string, listener: (event: unknown) => void],
  Promise<{ remove: () => Promise<void> }>
>;

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
  registerPlugin: () => ({ addListener }),
}));

const { initializeCapacitorAudioLifecycle } = await import(
  "./capacitor-audio-lifecycle"
);

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Capacitor audio lifecycle bridge", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("ios");
    addListener.mockClear();
    removeInterruption.mockClear();
    removeRouteChange.mockClear();
  });

  it("registers audio interruption and route change listeners on iOS", async () => {
    initializeCapacitorAudioLifecycle();
    await flushAsync();

    expect(addListener).toHaveBeenCalledWith(
      "audioInterruption",
      expect.any(Function),
    );
    expect(addListener).toHaveBeenCalledWith(
      "audioRouteChange",
      expect.any(Function),
    );
  });

  it("dispatches babylonslate:audiointerruption from the native plugin", async () => {
    initializeCapacitorAudioLifecycle();
    await flushAsync();

    const handler = addListener.mock.calls.find(
      (call) => call[0] === "audioInterruption",
    )?.[1];
    const listener = vi.fn();
    window.addEventListener("babylonslate:audiointerruption", listener);

    handler!({ type: "began" });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { type: "began" },
      }),
    );
  });

  it("dispatches babylonslate:audioroutechange from the native plugin", async () => {
    initializeCapacitorAudioLifecycle();
    await flushAsync();

    const handler = addListener.mock.calls.find(
      (call) => call[0] === "audioRouteChange",
    )?.[1];
    const listener = vi.fn();
    window.addEventListener("babylonslate:audioroutechange", listener);

    handler!({ reason: 1 });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { reason: 1 },
      }),
    );
  });

  it("does not register listeners on web", async () => {
    getPlatform.mockReturnValue("web");
    initializeCapacitorAudioLifecycle();
    await flushAsync();

    expect(addListener).not.toHaveBeenCalled();
  });

  it("removes both listeners on cleanup", async () => {
    const cleanup = initializeCapacitorAudioLifecycle();
    await flushAsync();

    cleanup();
    await flushAsync();

    expect(removeInterruption).toHaveBeenCalled();
    expect(removeRouteChange).toHaveBeenCalled();
  });
});
