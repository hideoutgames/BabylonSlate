import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultBehaviourTree } from "@babylonslate/behaviour-tree";
import { BehaviourTreeEditor } from "./behaviour-tree-editor";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

const openDocument = vi.hoisted(() => vi.fn());

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "class-1", name: "BTTask_Custom", type: "Class" },
          path: "assets/BTTask_Custom.class.babasset",
        },
        {
          header: { guid: "bb-1", name: "Guard", type: "Blackboard" },
          path: "assets/Guard.blackboard.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "bb-1"
          ? { header: { guid: "bb-1", name: "Guard", type: "Blackboard" } }
          : undefined,
    },
    openDocument,
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({
    playing: false,
    liveBtState: null,
    focusedNodeId: null,
  }),
}));

afterEach(() => {
  cleanup();
  openDocument.mockClear();
});

describe("BehaviourTreeEditor", () => {
  it("renders the default selector/sequence/succeed tree and relayout", () => {
    const onChange = vi.fn();
    render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree("Patrol") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("behaviour-tree-editor")).toBeTruthy();
    expect(screen.getByTestId("bt-node-root")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bt-relayout"));
    expect(onChange).toHaveBeenCalled();
  });

  it("adds a decorator as an attached row on the selected node", () => {
    const onChange = vi.fn();
    render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("bt-add-decorator"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      nodes: Array<{ id: string; decorators: unknown[] }>;
    };
    const sequence = next.nodes.find((node) => node.id === "root");
    expect(sequence?.decorators.length).toBeGreaterThan(0);
  });
});
