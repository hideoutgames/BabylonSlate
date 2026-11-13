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
import { createDefaultSpritePayload } from "@haptic/assets";
import { createDefaultAnimGraph } from "@haptic/anim-graph";
import { DocumentWorkspace } from "./document-workspace";
import { dockviewApiKey, type DockviewSurface } from "../shell/dockview-surface";
import { captureAdaptiveDockviewLayout } from "../shell/phone-dock-layout";
import type { DocumentsOverrides } from "../testing/document-context-mock";

const SPRITE = "sprite:assets/Hero.sprite.hasset";
const ANIM = "anim-graph:assets/Loco.anim3d.hasset";
const DOCUMENTS = [
  { id: SPRITE, ref: { kind: "sprite", path: "assets/Hero.sprite.hasset" }, content: createDefaultSpritePayload() },
  { id: ANIM, ref: { kind: "anim-graph-3d", path: "assets/Loco.anim3d.hasset" }, content: createDefaultAnimGraph("Loco") },
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

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => harness.docs as DocumentsOverrides));
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
  ];
  return {
    panelComponents: Object.fromEntries(components.map((id) => [id, panel])),
  };
});

/**
 * Stands in for DocumentProvider's dock registry and layout store with the
 * same callback identities: every callback is stable.
 */
function Editor({ initialTabs, coldTabs = [] }: { initialTabs: string[]; coldTabs?: string[] }) {
  const [tabOrder, setTabs] = useState(initialTabs);
  const [activeDocumentId, setActive] = useState(initialTabs[0]!);
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
      const api = harness.apis.get(dockviewApiKey(id));
      if (api) harness.layouts.set(id, captureAdaptiveDockviewLayout(api));
    },
    [],
  );
  harness.control = { setTabs, setActive };
  harness.docs = {
    tabOrder,
    activeDocumentId,
    openDocuments: DOCUMENTS.map((doc) => ({
      ...doc,
      content: coldTabs.includes(doc.id) ? null : doc.content,
      layout: harness.layouts.get(doc.id) ?? null,
    })),
    projectDocument: { metadata: { name: "Test" } },
    assetRegistry: null,
    sourceControl: { enabled: false },
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
  fireEvent.click(within(sprite).getByRole("button", { name: "Close Inspector" }));
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
  it("does not mount a restored cold tab until its content finishes loading", () => {
    const view = render(<Editor initialTabs={[SPRITE]} coldTabs={[SPRITE]} />);
    expect(screen.queryByTestId("document-workspace-sprite")).toBeNull();
    expect(screen.queryByTestId("panel-sprite-preview")).toBeNull();
    expect(harness.apis.size).toBe(0);

    view.rerender(<Editor initialTabs={[SPRITE]} />);
    expect(screen.getByTestId("document-workspace-sprite")).toBeTruthy();
    expect(screen.getByTestId("panel-sprite-preview")).toBeTruthy();
    expect(harness.apis.has(dockviewApiKey(SPRITE))).toBe(true);
  });

  it("gives an Animation Graph one DockView holding its Animation Object window, and keeps saving a background document's windows", () => {
    render(<Editor initialTabs={[SPRITE, ANIM]} />);
    expect(screen.getByTestId("panel-sprite-details")).toBeTruthy();

    // The Sprite stays mounted in the background while the graph is shown.
    act(() => harness.control!.setActive(ANIM));
    const anim = screen.getByTestId("document-workspace-anim-graph");
    expect(within(anim).getByTestId("panel-anim-graph-graph")).toBeTruthy();
    expect(harness.apis.has(dockviewApiKey(ANIM))).toBe(true);
    expect(saveLayout(ANIM)).toEqual(expect.arrayContaining(["anim-graph-graph", "anim-object-graph"]));
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
