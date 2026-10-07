import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  it("opens a readable selected log message without expanding every row", () => {
    render(<OutputLogPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getAllByTestId("output-log-line")[0]!);
    const details = within(screen.getByRole("region", { name: "Log Details" }));
    expect(details.getByText("log line 0")).toBeTruthy();
    expect(details.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
  afterEach(() => {
    cleanup();
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
