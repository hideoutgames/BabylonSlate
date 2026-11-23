import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSessionTrail, sessionTrailEvents } from "@haptic/core";
import { installPreloadErrorReload } from "./preload-error-reload";

afterEach(() => resetSessionTrail());

function fakeWindow(storage: Pick<Storage, "getItem" | "setItem">) {
  const reload = vi.fn();
  const target = Object.assign(new EventTarget(), {
    sessionStorage: storage as Storage,
    location: { reload },
    coiReloading: undefined as boolean | undefined,
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

  it("cancels loads that fail during the isolation reload without spending the session's reload", () => {
    const { target, reload, fire } = fakeWindow(memoryStorage());
    installPreloadErrorReload(target);
    target.coiReloading = true;
    // The page is already reloading: the failed import must not throw into the page it replaces.
    expect(fire().defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    // A missing chunk on the reloaded page still gets the session's one reload.
    target.coiReloading = undefined;
    expect(fire().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("records what failed to import and whether it reloads in the session trail, before the reload", () => {
    const { target, reload } = fakeWindow(memoryStorage());
    const atReload: string[][] = [];
    reload.mockImplementation(() => atReload.push(sessionTrailEvents().map((event) => `${event.kind}: ${event.detail}`)));
    installPreloadErrorReload(target);
    const fire = () => {
      const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
        payload: new Error("Failed to fetch dynamically imported module: https://example.test/assets/a-1b2c3d.js"),
      });
      target.dispatchEvent(event);
    };
    fire();
    expect(atReload).toEqual([[
      "chunk import failed: Failed to fetch dynamically imported module: https://example.test/assets/a-1b2c3d.js; reloading the page",
      "reload: a failed chunk import",
    ]]);
    fire();
    expect(sessionTrailEvents().at(-1)).toMatchObject({
      kind: "chunk import failed",
      detail: "Failed to fetch dynamically imported module: https://example.test/assets/a-1b2c3d.js; no reload: this session already reloaded once (or has no session storage)",
    });
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
