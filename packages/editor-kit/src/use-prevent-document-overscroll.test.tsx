import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreventDocumentOverscroll } from "./use-prevent-document-overscroll";

function Host({ enabled = true }: { enabled?: boolean }) {
  usePreventDocumentOverscroll(enabled);
  return <div data-testid="shell">shell</div>;
}

describe("usePreventDocumentOverscroll", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("prevents touchmove on non-scrollable shell areas", () => {
    render(<Host />);
    const shell = document.querySelector("[data-testid='shell']")!;
    const event = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [{ clientX: 0, clientY: 20 } as Touch],
    });
    Object.defineProperty(event, "target", { value: shell });
    document.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        touches: [{ clientX: 0, clientY: 0 } as Touch],
      }),
    );
    shell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing when disabled", () => {
    render(<Host enabled={false} />);
    const shell = document.querySelector("[data-testid='shell']")!;
    const event = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [{ clientX: 0, clientY: 20 } as Touch],
    });
    Object.defineProperty(event, "target", { value: shell });
    shell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing on fine pointers", () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(<Host />);
    const shell = document.querySelector("[data-testid='shell']")!;
    const event = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [{ clientX: 0, clientY: 20 } as Touch],
    });
    Object.defineProperty(event, "target", { value: shell });
    shell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
