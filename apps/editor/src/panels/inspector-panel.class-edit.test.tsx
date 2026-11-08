import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { indexedAssetRegistry } from "../testing/indexed-asset-registry";

// One value for every render, so the registry and open documents keep their identity until a test replaces them.
const docs = vi.hoisted(() => ({
  openDocuments: [] as unknown[],
  documentRevisions: { graph: 1 } as Record<string, number>,
  projectDocument: { settings: {} },
  assetRegistry: null as unknown,
}));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "graph:assets/Hero.class.hasset" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => docs));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ focusDiagnostic: null, setFocusDiagnostic: vi.fn() }) }));
vi.mock("../context/play-context", () => ({ usePlay: () => ({ focusedNodeId: null }),
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null }));
afterEach(cleanup);

const dispatcher = (id: string, name: string) => ({ id, kind: "dispatcher", name, pins: [] });
const classTab = (name: string, members: unknown[]) => ({
  id: `graph:assets/${name}.class.hasset`,
  ref: { kind: "graph", path: `assets/${name}.class.hasset`, label: name },
  content: { nodes: [], edges: [], members },
  layout: null,
  dirty: true,
});

describe("Class Inspector during Class edits", () => {
  it("offers another open Class tab's new Event Dispatcher as a signature without reading any Class header again", async () => {
    const reads: string[] = [];
    const classAsset = (name: string, payload: Record<string, unknown>) => ({
      rootId: "project",
      path: `assets/${name}.class.hasset`,
      header: {
        guid: `${name}-guid`, type: "Class", name, parentClass: "Actor",
        get payload() {
          reads.push(name);
          return payload;
        },
      },
    });
    docs.assetRegistry = indexedAssetRegistry([
      classAsset("Hero", {}),
      classAsset("Door", {}),
      classAsset("Lamp", { dispatchers: [{ id: "lit", name: "On Lit", pins: [] }] }),
    ]);
    const hero = classTab("Hero", [dispatcher("hit", "On Hit")]);
    docs.openDocuments = [hero, classTab("Door", [dispatcher("open", "On Open")])];
    const host = () => (
      <PrefabEditingProvider initialSelectedId={null}>
        <GraphEditingProvider initialSelectedMemberId="hit">
          <InspectorPanel {...({} as IDockviewPanelProps)} />
        </GraphEditingProvider>
      </PrefabEditingProvider>
    );
    const view = render(host());
    expect(screen.getByTestId("inspector-member-dispatcher")).toBeTruthy();
    expect(reads).toContain("Lamp");
    reads.length = 0;

    // The Door tab gains a dispatcher: only the Class documents advance.
    docs.openDocuments = [hero, classTab("Door", [dispatcher("open", "On Open"), dispatcher("lock", "On Lock")])];
    docs.documentRevisions = { graph: 2 };
    view.rerender(host());
    expect(reads).toEqual([]);
    fireEvent.click(screen.getByTestId("inspector-dispatcher-copy-signature"));
    expect(await screen.findByText("On Lock")).toBeTruthy();
    expect(screen.getByText("On Lit")).toBeTruthy();
  });
});
