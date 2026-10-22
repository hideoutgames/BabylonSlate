import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createCommandRegistry } from "@haptic/debugger";
import type { DebugInspectNode } from "@haptic/object-model";
import { createInspectWorldStore } from "../lib/inspect-world-store";
import { PlayDebugConsole } from "./play-debug-console";

function actor(id: string, label: string): DebugInspectNode {
  return { id, kind: "actor", label, classId: "Actor", parentId: null, variables: {} };
}

describe("PlayDebugConsole", () => {
  afterEach(() => {
    cleanup();
  });

  const commands = createCommandRegistry().list();
  function renderConsole(store = createInspectWorldStore()) {
    render(
      <PlayDebugConsole
        open
        onOpenChange={() => {}}
        commands={commands}
        onExecute={() => ({ success: true, output: "" })}
        inspectStore={store}
        scenes={[{ guid: "scene-1", scene: { name: "North" } }]}
      />,
    );
    return store;
  }

  it("completes actor names from the live inspect snapshot as actors appear and leave", () => {
    const store = renderConsole();
    fireEvent.change(screen.getByTestId("debug-console-input"), { target: { value: "inspect " } });
    expect(screen.queryByTestId("debug-console-suggest-Hero")).toBeNull();

    act(() => store.publish({ tickIndex: 1, nodes: [actor("hero-guid", "Hero")] }));
    expect(screen.getByTestId("debug-console-suggest-Hero")).toBeTruthy();
    expect(screen.getByTestId("debug-console-suggest-hero-guid")).toBeTruthy();

    act(() => store.publish({ tickIndex: 2, nodes: [] }));
    expect(screen.queryByTestId("debug-console-suggest-Hero")).toBeNull();
  });

  it("still completes the Scene names it is given", () => {
    renderConsole();
    fireEvent.change(screen.getByTestId("debug-console-input"), { target: { value: "changescene " } });
    expect(screen.getByTestId("debug-console-suggest-North")).toBeTruthy();
  });
});
