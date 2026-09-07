import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { AssetOpenProvider } from "@babylonslate/editor-kit";
import { assetRef, classRef, pin } from "@babylonslate/scripting";
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
const fixture = vi.hoisted(() => ({ kind: "asset" as "asset" | "class" }));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "graph:assets/Hero.class.babasset",
        ref: {
          kind: "graph",
          path: "assets/Hero.class.babasset",
          label: "Hero Class",
        },
        content: {
          nodes: [
            {
              id: "play-1",
              type: fixture.kind === "asset" ? "audio.play" : "actor.getAllOfClass",
              position: { x: 80, y: 80 },
              data: fixture.kind === "asset" ? {
                title: "Play Sound",
                __nodeType: "audio.play",
                __pins: [
                  pin("asset", "Asset", "in", assetRef("Audio")),
                ],
                "default:asset": "audio-1",
              } : {
                title: "Get All Actors Of Class",
                __nodeType: "actor.getAllOfClass",
                __pins: [pin("classId", "Class", "in", classRef("Actor"))],
                "default:classId": "Pawn",
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

function renderPlaySoundInspector() {
  return render(
    <AssetOpenProvider
      value={{
        canOpen: (guid) => guid === "audio-1",
        openAsset: () => {},
      }}
    >
      <PrefabEditingProvider initialSelectedId={null}>
        <GraphEditingProvider initialSelectedNodeIds={["play-1"]}>
          <InspectorPanel {...({} as IDockviewPanelProps)} />
        </GraphEditingProvider>
      </PrefabEditingProvider>
    </AssetOpenProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  fixture.kind = "asset";
});

describe("Inspector node pin Defaults", () => {
  it("shows Open Asset on an assetRef Default when the guid can open", () => {
    renderPlaySoundInspector();
    expect(screen.getByTestId("inspector-pin-defaults")).toBeTruthy();
    expect(screen.getByTestId("property-asset")).toBeTruthy();
    expect(screen.getByTestId("property-asset-open")).toBeTruthy();
  });

  it("clears an existing asset default through the picker using the pin ID", async () => {
    renderPlaySoundInspector();
    fireEvent.click(screen.getByTestId("property-asset"));
    fireEvent.click(await screen.findByTestId("search-item-__none__"));
    await waitFor(() => expect(applyGraphChange).toHaveBeenCalled());
    const next = applyGraphChange.mock.calls.at(-1)![1];
    expect(next.nodes[0]!.data["default:asset"]).toBe("");
    expect(next.nodes[0]!.data).not.toHaveProperty("default:Asset");
  });

  it("replaces an existing class default through the picker using the pin ID", async () => {
    fixture.kind = "class";
    renderPlaySoundInspector();
    fireEvent.click(screen.getByTestId("property-classId"));
    fireEvent.click(await screen.findByTestId("search-item-Actor"));
    await waitFor(() => expect(applyGraphChange).toHaveBeenCalled());
    const next = applyGraphChange.mock.calls.at(-1)![1];
    expect(next.nodes[0]!.data["default:classId"]).toBe("Actor");
    expect(next.nodes[0]!.data).not.toHaveProperty("default:Class");
  });
});
