import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPlayerPrintOverlay } from "./print-overlay";

type FakeNode = {
  style: { cssText: string; color: string };
  dataset: Record<string, string>;
  hidden: boolean;
  textContent: string;
  children: FakeNode[];
  appendChild: (child: FakeNode) => FakeNode;
  replaceChildren: (...nodes: FakeNode[]) => void;
  remove: () => void;
};

function fakeNode(): FakeNode {
  const node: FakeNode = {
    style: { cssText: "", color: "" },
    dataset: {},
    hidden: false,
    textContent: "",
    children: [],
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      node.children = nodes;
    },
    remove() {},
  };
  return node;
}

describe("mountPlayerPrintOverlay", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows a print without a debugger bundle and expires duration 0 after one frame", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const parent = fakeNode();
    vi.stubGlobal("document", {
      createElement: () => fakeNode(),
    });

    const overlay = mountPlayerPrintOverlay(parent as unknown as HTMLElement);
    overlay.applyPrint({ message: "hello", key: "hp", duration: 0 });
    const host = parent.children[0]!;
    expect(host.dataset.testid).toBe("print-overlay");
    expect(host.children[0]?.textContent).toBe("hello");
    expect(host.hidden).toBe(false);
    expect(raf).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(host.children).toHaveLength(0);
    expect(host.hidden).toBe(true);
    overlay.dispose();
  });
});
