// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { primeSoftKeyboard } from "./soft-keyboard";

function stubPointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const proxies = () => document.querySelectorAll("[data-soft-keyboard-prime]");

describe("primeSoftKeyboard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("does nothing without a coarse pointer", () => {
    stubPointer(false);
    primeSoftKeyboard();
    expect(proxies()).toHaveLength(0);
  });

  it("holds focus in a hidden field until the real field takes it, then leaves", () => {
    stubPointer(true);
    primeSoftKeyboard();
    const [proxy] = proxies();
    expect(proxy).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(proxy);
    expect(proxy?.getAttribute("aria-hidden")).toBe("true");

    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(proxies()).toHaveLength(0);
  });

  it("blurs and leaves when no field takes focus in time", () => {
    vi.useFakeTimers();
    stubPointer(true);
    primeSoftKeyboard(500);
    expect(proxies()).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(proxies()).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });
});
