import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { TREE_ROW_HEIGHT, WINDOWED_SLICE_OVERSCAN } from "@babylonslate/editor-kit";
import { OutputLogPanel } from "./output-log-panel";

const lines = Array.from({ length: 500 }, (_, i) => `log line ${i}`);

vi.mock("../context/play-context", () => ({
  useOutputLog: () => ({ lines }),
}));

const VIEWPORT = '[data-slot="scroll-area-viewport"]';

function stubScrollViewportHeight(height: number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).matches?.(VIEWPORT)) {
        return height;
      }
      return descriptor?.get?.call(this) ?? 0;
    },
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", descriptor);
    }
  };
}

describe("OutputLogPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts every log line when the viewport height is 0", () => {
    render(<OutputLogPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getAllByTestId("output-log-line")).toHaveLength(500);
  });

  it("windows 500 log lines to the viewport plus overscan", () => {
    const restore = stubScrollViewportHeight(280);
    try {
      render(<OutputLogPanel {...({} as IDockviewPanelProps)} />);
      const mounted = screen.getAllByTestId("output-log-line");
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(40);
      expect(mounted.length).toBeLessThanOrEqual(
        Math.ceil(280 / TREE_ROW_HEIGHT) + WINDOWED_SLICE_OVERSCAN * 2,
      );
      expect(screen.queryByText("log line 0")).toBeTruthy();
      expect(screen.queryByText("log line 499")).toBeNull();
    } finally {
      restore();
    }
  });
});
