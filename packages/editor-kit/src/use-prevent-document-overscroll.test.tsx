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

  it("listens for touchstart in the capture phase", () => {
    const add = vi.spyOn(document, "addEventListener");
    render(<Host />);
    expect(add).toHaveBeenCalledWith(
      "touchstart",
      expect.any(Function),
      expect.objectContaining({ capture: true }),
    );
    add.mockRestore();
  });

  it.each(["x", "y"])(
    "allows a %s scroll to reverse immediately after an outward drag at its edge",
    (axis) => {
      const { getByTestId } = render(<Host />);
      const shell = getByTestId("shell");
      shell.style.overflowX = "auto";
      shell.style.overflowY = "auto";
      Object.defineProperties(shell, {
        clientWidth: { value: 100 },
        clientHeight: { value: 100 },
        scrollWidth: { value: axis === "x" ? 300 : 100 },
        scrollHeight: { value: axis === "y" ? 300 : 100 },
      });
      const touch = (position: number) => [
        {
          clientX: axis === "x" ? position : 0,
          clientY: axis === "y" ? position : 0,
        } as Touch,
      ];
      shell.dispatchEvent(
        new TouchEvent("touchstart", { bubbles: true, touches: touch(40) }),
      );
      const outward = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: touch(70),
      });
      shell.dispatchEvent(outward);
      expect(outward.defaultPrevented).toBe(true);

      // The finger is still past its starting point, but now moves inward.
      const inward = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: touch(60),
      });
      shell.dispatchEvent(inward);
      expect(inward.defaultPrevented).toBe(false);
    },
  );

  it("leaves an interrupted multi-touch gesture alone until a new contact starts", () => {
    const { getByTestId } = render(<Host />);
    const shell = getByTestId("shell");
    shell.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        touches: [{ clientX: 0, clientY: 0 } as Touch],
      }),
    );
    shell.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        touches: [
          { clientX: 0, clientY: 0 } as Touch,
          { clientX: 20, clientY: 20 } as Touch,
        ],
      }),
    );
    shell.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [{ clientX: 0, clientY: 0 } as Touch],
      }),
    );
    const remainingFingerMove = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [{ clientX: 0, clientY: 20 } as Touch],
    });
    shell.dispatchEvent(remainingFingerMove);
    expect(remainingFingerMove.defaultPrevented).toBe(false);
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
