import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { DocumentWorkspace } from "./document-workspace";
import {
  parseAnimDocumentLayout,
  serializeAnimDocumentLayout,
  type AnimEditorMode,
} from "../shell/anim-document-layout";
import { dockviewApiKey, type DockviewSurface } from "../shell/dockview-surface";
import { captureAdaptiveDockviewLayout } from "../shell/phone-dock-layout";

const SPRITE = "sprite:assets/Hero.sprite.babasset";
const ANIM = "anim-graph:assets/Loco.anim.babasset";
const DOCUMENTS = [
  { id: SPRITE, ref: { kind: "sprite", path: "assets/Hero.sprite.babasset" } },
  { id: ANIM, ref: { kind: "anim-graph", path: "assets/Loco.anim.babasset" } },
];

const harness = vi.hoisted(() => ({
  docs: null as unknown,
  apis: new Map<string, DockviewApi>(),
  layouts: new Map<string, Record<string, unknown>>(),
  control: null as null | {
    setTabs: (tabs: string[]) => void;
    setActive: (id: string) => void;
  },
  passthrough: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => harness.docs));
// Editing sessions and panel bodies are outside the dock registration contract.
vi.mock("../context/audio-reverb-bake-context", () => ({
  AudioReverbBakeProvider: harness.passthrough,
}));
vi.mock("../context/anim-graph-editing-context", () => ({
  AnimGraphEditingProvider: harness.passthrough,
}));
vi.mock("../context/prefab-editing-context", () => ({
  PrefabEditingProvider: harness.passthrough,
}));
vi.mock("../context/graph-editing-context", () => ({
  GraphEditingProvider: harness.passthrough,
}));
vi.mock("./document-lock-banner", () => ({ DocumentLockBanner: () => null }));
vi.mock("../shell/panel-registry", () => {
  const panel = ({ api }: IDockviewPanelProps) => (
    <div data-testid={`panel-${api.id}`}>{api.title}</div>
  );
  const components = [
    "sprite-preview",
    "sprite-details",
    "anim-graph-graph",
    "anim-graph-variables",
    "anim-graph-details",
    "anim-graph-compiler-results",
    "anim-object-graph",
    "anim-object-variables",
    "anim-object-inspector",
  ];
  return {
    panelComponents: Object.fromEntries(components.map((id) => [id, panel])),
  };
});

/**
 * Stands in for DocumentProvider's dock registry and layout store with the
 * same callback identities: the registry callbacks are stable, while
 * captureLayoutForId changes identity when Animation Graph modes change
 * because an Animation Graph capture records its current mode.
 */
function Editor({ initialTabs }: { initialTabs: string[] }) {
  const [tabOrder, setTabs] = useState(initialTabs);
  const [activeDocumentId, setActive] = useState(initialTabs[0]!);
  const [animEditorModes, setAnimEditorModes] = useState<
    Record<string, AnimEditorMode>
  >({});
  const setAnimEditorMode = useCallback(
    (id: string, mode: AnimEditorMode) =>
      setAnimEditorModes((current) => ({ ...current, [id]: mode })),
    [],
  );
  const registerDockviewApi = useCallback(
    (id: string, api: DockviewApi, surface?: DockviewSurface) => {
      harness.apis.set(dockviewApiKey(id, surface), api);
    },
    [],
  );
  const unregisterDockviewApi = useCallback(
    (id: string, surface?: DockviewSurface) => {
      harness.apis.delete(dockviewApiKey(id, surface));
    },
    [],
  );
  const captureLayoutForId = useCallback(
    (id: string) => {
      const capture = (surface?: DockviewSurface) => {
        const api = harness.apis.get(dockviewApiKey(id, surface));
        return api ? captureAdaptiveDockviewLayout(api) : null;
      };
      if (id !== ANIM) {
        const layout = capture();
        if (layout) harness.layouts.set(id, layout);
        return;
      }
      const stored = parseAnimDocumentLayout(harness.layouts.get(id));
      harness.layouts.set(
        id,
        serializeAnimDocumentLayout({
          animEditorMode: animEditorModes[id] ?? "stateMachine",
          stateMachine: capture("stateMachine") ?? stored.stateMachine,
          animationObject: capture("animationObject") ?? stored.animationObject,
        }),
      );
    },
    [animEditorModes],
  );
  harness.control = { setTabs, setActive };
  harness.docs = {
    tabOrder,
    activeDocumentId,
    openDocuments: DOCUMENTS.map((doc) => ({
      ...doc,
      content: null,
      layout: harness.layouts.get(doc.id) ?? null,
    })),
    projectDocument: { metadata: { name: "Test" } },
    assetRegistry: null,
    sourceControl: { enabled: false },
    animEditorMode: animEditorModes[activeDocumentId] ?? "stateMachine",
    setAnimEditorMode,
    registerDockviewApi,
    unregisterDockviewApi,
    captureLayoutForId,
  };
  return <DocumentWorkspace />;
}

/** Save captures each open document's live dock layout before writing. */
function saveLayout(id: string): string[] {
  act(() => {
    (harness.docs as { captureLayoutForId: (id: string) => void })
      .captureLayoutForId(id);
  });
  const saved = harness.layouts.get(id) as
    | { panels?: Record<string, unknown> }
    | undefined;
  return Object.keys(saved?.panels ?? {});
}

function closeSpriteDetails() {
  const sprite = screen.getByTestId("document-workspace-sprite");
  fireEvent.click(within(sprite).getByRole("button", { name: "Close Details" }));
  expect(within(sprite).queryByTestId("panel-sprite-details")).toBeNull();
}

afterEach(() => {
  cleanup();
  harness.apis.clear();
  harness.layouts.clear();
  harness.control = null;
  harness.docs = null;
});

describe("document dock lifetime", () => {
  it("keeps saving a background document's windows after an Animation Graph switches mode", () => {
    render(<Editor initialTabs={[SPRITE, ANIM]} />);
    expect(screen.getByTestId("panel-sprite-details")).toBeTruthy();

    // The Sprite stays mounted in the background while the graph changes mode.
    act(() => harness.control!.setActive(ANIM));
    fireEvent.click(screen.getByTestId("anim-editor-mode-animation-object"));
    expect(
      screen
        .getByTestId("anim-dock-surface-animation-object")
        .getAttribute("data-active"),
    ).toBe("true");
    expect(screen.getByTestId("document-workspace-sprite")).toBeTruthy();

    act(() => harness.control!.setActive(SPRITE));
    closeSpriteDetails();
    expect(saveLayout(SPRITE)).toEqual(["sprite-preview"]);
  });

  it("reopens a document with the windows arranged before its workspace unmounted", () => {
    render(<Editor initialTabs={[SPRITE]} />);
    closeSpriteDetails();

    act(() => harness.control!.setTabs([]));
    expect(screen.queryByTestId("document-workspace-sprite")).toBeNull();
    act(() => harness.control!.setTabs([SPRITE]));

    expect(screen.getByTestId("panel-sprite-preview")).toBeTruthy();
    expect(screen.queryByTestId("panel-sprite-details")).toBeNull();
  });
});
