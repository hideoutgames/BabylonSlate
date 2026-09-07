import { afterEach, describe, expect, it, vi } from "vitest";
import { attachLifecyclePause } from "./lifecycle-pause";

describe("attachLifecyclePause", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("pauses on document hide and resumes on visible", () => {
    const handler = vi.fn();
    const detach = attachLifecyclePause(handler);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(handler).toHaveBeenLastCalledWith(true);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(handler).toHaveBeenLastCalledWith(false);

    detach();
    handler.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("reacts to the vfs-forwarded appstate custom event on mobile hosts", async () => {
    vi.resetModules();
    vi.doMock("@babylonslate/vfs", () => ({
      getHostPlatform: () => "ios" as const,
    }));
    const { attachLifecyclePause: attach } = await import("./lifecycle-pause");
    const handler = vi.fn();
    const detach = attach(handler);

    await vi.waitFor(() => {
      window.dispatchEvent(
        new CustomEvent("babylonslate:appstate", {
          detail: { isActive: false },
        }),
      );
      expect(handler).toHaveBeenCalledWith(true);
    });

    window.dispatchEvent(
      new CustomEvent("babylonslate:appstate", {
        detail: { isActive: true },
      }),
    );
    expect(handler).toHaveBeenLastCalledWith(false);
    detach();
    vi.doUnmock("@babylonslate/vfs");
  });

  it("keeps rendering paused until both native activity and visibility allow resume", () => {
    const handler = vi.fn();
    const detach = attachLifecyclePause(handler);
    window.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: false } }));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(handler).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: true } }));
    expect(handler).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(handler).toHaveBeenLastCalledWith(false);
    detach();
  });

  it("starts paused when mounted in a hidden document", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const handler = vi.fn();
    const detach = attachLifecyclePause(handler);
    expect(handler).toHaveBeenCalledWith(true);
    detach();
  });
});
