import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldPreventDocumentOverscroll } from "./prevent-document-overscroll";

function mountScrollable(
  options: {
    height?: number;
    scrollHeight?: number;
    scrollTop?: number;
    overflowY?: string;
  } = {},
): HTMLDivElement {
  const el = document.createElement("div");
  const {
    height = 100,
    scrollHeight = 200,
    scrollTop = 0,
    overflowY = "auto",
  } = options;
  el.style.height = `${height}px`;
  el.style.overflowY = overflowY;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  document.body.appendChild(el);
  return el;
}

describe("prevent-document-overscroll", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("shouldPreventDocumentOverscroll", () => {
    beforeEach(() => {
      document.documentElement.style.overflow = "hidden";
    });

    it("prevents when the target is not inside a scrollable region", () => {
      const shell = document.createElement("div");
      document.body.appendChild(shell);
      expect(shouldPreventDocumentOverscroll(shell, 0, 10)).toBe(true);
    });

    it("allows when a scrollable ancestor can absorb the gesture", () => {
      const scrollable = mountScrollable({ scrollTop: 50 });
      const child = document.createElement("span");
      scrollable.appendChild(child);
      expect(shouldPreventDocumentOverscroll(child, 0, 10)).toBe(false);
    });

    it("prevents at the scroll boundary when rubber-band would fire", () => {
      const scrollable = mountScrollable({ scrollTop: 0 });
      const child = document.createElement("span");
      scrollable.appendChild(child);
      expect(shouldPreventDocumentOverscroll(child, 0, 10)).toBe(true);
    });

    it("allows an upward drag until the scrollable ancestor reaches its bottom", () => {
      const scrollable = mountScrollable({ scrollTop: 0 });
      const child = document.createElement("span");
      scrollable.appendChild(child);
      expect(shouldPreventDocumentOverscroll(child, 0, -10)).toBe(false);

      scrollable.scrollTop = 100;
      expect(shouldPreventDocumentOverscroll(child, 0, -10)).toBe(true);
    });

    it("prevents when an overflowing ancestor hides its overflow", () => {
      const clipped = mountScrollable({ scrollTop: 50, overflowY: "hidden" });
      const child = document.createElement("span");
      clipped.appendChild(child);
      expect(shouldPreventDocumentOverscroll(child, 0, 10)).toBe(true);
    });

    it("allows native editing targets so iPad selection handles can drag", () => {
      const field = document.createElement("textarea");
      document.body.appendChild(field);
      expect(shouldPreventDocumentOverscroll(field, 0, 10)).toBe(false);

      const input = document.createElement("input");
      document.body.appendChild(input);
      expect(shouldPreventDocumentOverscroll(input, 0, 10)).toBe(false);
    });
  });
});
