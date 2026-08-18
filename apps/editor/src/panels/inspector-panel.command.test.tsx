import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, next: SerializedGraph) => Promise<boolean>>(
    async () => true,
  ),
);

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Heal.class.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "graph:assets/Heal.class.babasset",
        ref: {
          kind: "graph",
          path: "assets/Heal.class.babasset",
          label: "Heal Class",
        },
        content: {
          nodes: [
            {
              id: "cmd-1",
              type: "flow.event.commandRun",
              position: { x: 80, y: 80 },
              data: {
                title: "Event On Command Run",
                commandName: "pause",
                description: "Heal",
                category: "game",
                parameters: [],
                __nodeType: "flow.event.commandRun",
              },
            },
          ],
          edges: [],
          members: [],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    projectDocument: { settings: { input: { actions: [], axes: [] } } },
    assetRegistry: { list: () => [] },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    focusDiagnostic: null,
    setFocusDiagnostic: vi.fn(),
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

function renderCommandInspector() {
  return render(
    <PrefabEditingProvider initialSelectedId={null}>
      <GraphEditingProvider initialSelectedNodeIds={["cmd-1"]}>
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

describe("Inspector Command Name", () => {
  it("shows an error when the authored name is reserved by the engine", () => {
    renderCommandInspector();
    const input = screen.getByTestId("command-name") as HTMLInputElement;
    expect(input.value).toBe("pause");
    expect(screen.getByTestId("command-name-reserved").textContent).toContain(
      "reserved",
    );
  });
});
