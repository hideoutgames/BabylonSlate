import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canScrollInDirection,
  isScrollableAxis,
  shouldPreventDocumentOverscroll,
} from "./prevent-document-overscroll";

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

  describe("isScrollableAxis", () => {
    it("detects vertical scroll overflow", () => {
      const el = mountScrollable();
      expect(isScrollableAxis(el, "y")).toBe(true);
      expect(isScrollableAxis(el, "x")).toBe(false);
    });

    it("returns false when overflow is hidden", () => {
      const el = mountScrollable({ overflowY: "hidden" });
      expect(isScrollableAxis(el, "y")).toBe(false);
    });
  });

  describe("canScrollInDirection", () => {
    it("allows downward drag when not at the top", () => {
      const el = mountScrollable({ scrollTop: 20 });
      expect(canScrollInDirection(el, "y", 10)).toBe(true);
    });

    it("blocks downward drag at the top", () => {
      const el = mountScrollable({ scrollTop: 0 });
      expect(canScrollInDirection(el, "y", 10)).toBe(false);
    });

    it("allows upward drag when not at the bottom", () => {
      const el = mountScrollable({ scrollTop: 0 });
      expect(canScrollInDirection(el, "y", -10)).toBe(true);
    });

    it("blocks upward drag at the bottom", () => {
      const el = mountScrollable({ scrollTop: 100 });
      expect(canScrollInDirection(el, "y", -10)).toBe(false);
    });
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
  });
});
