import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultAnimGraph, type AnimGraphDocument } from "@babylonslate/anim-graph";
import { AnimGraphEditor } from "./anim-graph-editor";

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

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "spr-1", name: "Hero", type: "Sprite" },
          path: "assets/Hero.sprite.babasset",
        },
        {
          header: { guid: "anim-1", name: "Walk", type: "Animation" },
          path: "assets/Walk.animation.babasset",
        },
        {
          header: { guid: "tex-1", name: "Atlas", type: "Texture" },
          path: "assets/Atlas.texture.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "spr-1"
          ? { header: { guid: "spr-1", name: "Hero", type: "Sprite" } }
          : guid === "anim-1"
            ? { header: { guid: "anim-1", name: "Walk", type: "Animation" } }
            : undefined,
    },
  }),
}));

afterEach(() => {
  cleanup();
});

function locoGraph(): AnimGraphDocument {
  const doc = createDefaultAnimGraph();
  doc.parameters = ["moving"];
  doc.states.push({
    id: "run",
    name: "Run",
    clipId: "run-clip",
    speed: 1,
    loop: true,
    position: { x: 300, y: 80 },
  });
  doc.clips.push({
    id: "run-clip",
    kind: "sprite",
    assetGuid: "spr-1",
    clipName: "Run",
    durationMs: 400,
  });
  doc.transitions.push({
    id: "idle-to-run",
    fromStateId: "idle",
    toStateId: "run",
    condition: "moving",
    blendSeconds: 0.25,
    hasExitTime: false,
    exitTime: 0,
  });
  return doc;
}

describe("AnimGraphEditor", () => {
  it("hydrates in/out pins on state nodes", async () => {
    const { container } = render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-handleid="in"]')).not.toBeNull();
      expect(container.querySelector('[data-handleid="out"]')).not.toBeNull();
    });
  });

  it("lists the state node in Add Node", async () => {
    const { container } = render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".react-flow__pane")).not.toBeNull();
    });
    const pane = container.querySelector(".react-flow__pane");
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    await waitFor(() => {
      expect(screen.getByTestId("node-palette-item-anim.state")).toBeTruthy();
    });
  });

  it("lists Parameters and Add State", () => {
    render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("anim-graph-parameters")).toBeTruthy();
    expect(screen.getByTestId("anim-graph-add-state")).toBeTruthy();
    expect(screen.getByTestId("anim-graph-state-idle")).toBeTruthy();
  });

  it("adds a state from the States list", () => {
    const onChange = vi.fn();
    render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("anim-graph-add-state"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        states: expect.arrayContaining([
          expect.objectContaining({ id: "idle" }),
          expect.objectContaining({ name: "State" }),
        ]),
      }),
    );
    const next = onChange.mock.calls[0]![0] as AnimGraphDocument;
    expect(next.states).toHaveLength(2);
    expect(next.states[1]!.position.x).toBeGreaterThan(next.states[0]!.position.x);
  });

  it("shows Details after selecting a state and toggles loop", () => {
    const onChange = vi.fn();
    render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.getByTestId("property-name")).toBeTruthy();
    expect(screen.getByTestId("property-loop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-loop"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        states: [
          expect.objectContaining({ id: "idle", loop: false }),
        ],
      }),
    );
  });

  it("edits an outgoing transition without wiping its condition", () => {
    const onChange = vi.fn();
    render(
      <AnimGraphEditor
        payload={locoGraph() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-idle-to-run-hasExitTime"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        transitions: [
          expect.objectContaining({
            id: "idle-to-run",
            condition: "moving",
            blendSeconds: 0.25,
            hasExitTime: true,
          }),
        ],
      }),
    );
  });

  it("picks an Animation clip for the selected state", async () => {
    const onChange = vi.fn();
    render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-anim-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-anim-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        clips: expect.arrayContaining([
          expect.objectContaining({
            id: "idle-clip",
            kind: "animation",
            assetGuid: "anim-1",
          }),
        ]),
      }),
    );
  });
});
