import { describe, expect, it, vi } from "vitest";
import { installPreloadErrorReload } from "./preload-error-reload";

function fakeWindow(storage: Pick<Storage, "getItem" | "setItem">) {
  const reload = vi.fn();
  const target = Object.assign(new EventTarget(), {
    sessionStorage: storage as Storage,
    location: { reload },
  });
  const fire = () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { target, reload, fire };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("installPreloadErrorReload", () => {
  it("reloads for the first failed chunk of a session and leaves later failures to the error boundary", () => {
    const { target, reload, fire } = fakeWindow(memoryStorage());
    installPreloadErrorReload(target);
    const first = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    // Cancelled, so the failed import does not also throw into a page that is leaving.
    expect(first.defaultPrevented).toBe(true);
    const second = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
  });

  it("never reloads when session storage is unavailable, so a failing chunk cannot loop", () => {
    const { target, reload, fire } = fakeWindow({
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    installPreloadErrorReload(target);
    expect(fire().defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
