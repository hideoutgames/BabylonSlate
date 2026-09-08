import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlatformLayoutOptions } from "./use-platform-layout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installMediaQuery(initialPhone: boolean, initialTouch = false) {
  const queries = new Map<string, MediaQueryList>();
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("matchMedia", (query: string) => {
    if (!queries.has(query)) {
      const callbacks = new Set<() => void>();
      listeners.set(query, callbacks);
      queries.set(query, {
        matches: query === "(pointer: coarse)" ? initialTouch : initialPhone,
        media: query,
        addEventListener: (_event: string, callback: () => void) =>
          callbacks.add(callback),
        removeEventListener: (_event: string, callback: () => void) =>
          callbacks.delete(callback),
      } as unknown as MediaQueryList);
    }
    return queries.get(query);
  });
  return (phone: boolean) => {
    for (const [query, media] of queries) {
      if (query === "(pointer: coarse)") continue;
      Object.assign(media, { matches: phone });
      for (const callback of listeners.get(query) ?? []) callback();
    }
  };
}

describe("adaptive editor layout", () => {
  it("adapts to phone space and restores docking when the window grows", () => {
    const resize = installMediaQuery(false);
    const { result } = renderHook(() => usePlatformLayoutOptions());
    expect(result.current).toMatchObject({
      singleWindow: false,
      disableFloatingGroups: false,
    });
    act(() => resize(true));
    expect(result.current).toMatchObject({
      singleWindow: true,
      disableFloatingGroups: true,
    });
    act(() => resize(false));
    expect(result.current).toMatchObject({
      singleWindow: false,
      disableFloatingGroups: false,
    });
  });

  it("uses pointer dragging on a touch tablet while keeping the docked layout", () => {
    installMediaQuery(false, true);
    const { result } = renderHook(() => usePlatformLayoutOptions());
    expect(result.current).toMatchObject({
      singleWindow: false,
      dndStrategy: "pointer",
    });
  });
});
