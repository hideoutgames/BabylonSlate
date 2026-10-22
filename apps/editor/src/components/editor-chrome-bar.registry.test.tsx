import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetRegistry, projectContentRoot } from "@haptic/assets";
import type { Diagnostic } from "@haptic/scripting";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@haptic/core";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { GraphDebugProvider, useGraphDebugStore } from "../context/graph-debug-context";
import { MaterialRenderControlProvider } from "../context/material-render-control-context";
import type { OpenDocument } from "../services/document-service";
import type { GraphDebugStore } from "../services/graph-debug-store";
import { EditorChromeBar } from "./editor-chrome-bar";

const state = vi.hoisted(() => ({
  registry: null as AssetRegistry | null,
  documents: [] as OpenDocument[],
  phone: false,
  errorCount: 0,
  activeId: "first",
  canPlay: false,
  sceneViewportLoading: false,
  compileDiagnostics: [] as Diagnostic[],
  setDiagnostics: vi.fn(),
  requestPlay: vi.fn(),
  requestSimulate: vi.fn(),
  simulationUnavailableReason: null as string | null,
  sessionState: { generation: 0, mode: null as "simulate" | null, lifecycle: "idle", quarantined: false, error: null },
  stopSession: vi.fn(),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  projectName: "Test",
  openDocuments: state.documents,
  activeDocumentId: state.activeId,
  dirtyDocuments: state.documents.filter((doc) => doc.dirty),
  projectDirty: false,
  assetRegistry: state.registry,
  registryEpoch: state.registry?.generation ?? 0,
  graphsNeedCompile: true,
  collectPlayPreviewScripts: async () => ({ bundles: [], diagnostics: state.compileDiagnostics }),
})));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({
    playing: false, preparing: false, canPlay: state.canPlay, sceneViewportLoading: state.sceneViewportLoading,
    requestPlay: state.requestPlay, requestSimulate: state.requestSimulate,
    simulationUnavailableReason: state.simulationUnavailableReason,
    previewBuild: false, setPreviewBuild: vi.fn(), playFromScene: true,
    sessionState: state.sessionState, sessionOwner: { stop: state.stopSession }, simulationDocumentId: null,
  }),
}));
vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ errorCount: state.errorCount, setDiagnostics: state.setDiagnostics }),
}));
vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => state.phone,
}));
// Keep document navigation real; isolate unrelated project tools and dialogs.
vi.mock("./settings-modal", () => ({ SettingsModal: () => null }));
vi.mock("./global-search-dialog", () => ({ GlobalSearchDialog: () => null }));
vi.mock("./windows-menu", () => ({ WindowsMenu: () => null }));

function Chrome({ onCloseAllDocuments }: { onCloseAllDocuments?: () => void }) {
  return (
    <MaterialRenderControlProvider>
      <TooltipProvider>
        <EditorChromeBar onCloseAllDocuments={onCloseAllDocuments} />
      </TooltipProvider>
    </MaterialRenderControlProvider>
  );
}

function openDocument(id: string, ref: OpenDocument["ref"]): OpenDocument {
  return { id, ref, content: null, layout: null, dirty: false };
}

async function createRegistry() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.hproject");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  state.registry = registry;
  return registry;
}

function typeIcon(element: HTMLElement) {
  return element
    .querySelector("[data-type-icon]")
    ?.getAttribute("data-type-icon");
}

function tabIcon(label: string) {
  const text = within(screen.getByTestId("document-tab-bar")).getByText(label);
  return typeIcon(text.closest("button")!);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.registry = null;
  state.documents = [];
  state.phone = false;
  state.errorCount = 0;
  state.activeId = "first";
  state.canPlay = false;
  state.sceneViewportLoading = false;
  state.compileDiagnostics = [];
  state.setDiagnostics.mockClear();
  state.requestPlay.mockClear();
  state.requestSimulate.mockClear();
  state.simulationUnavailableReason = null;
  state.sessionState = { generation: 0, mode: null, lifecycle: "idle", quarantined: false, error: null };
  state.stopSession.mockClear();
});

describe("chrome Play", () => {
  it("waits for a loading Scene viewport before Play", () => {
    state.canPlay = true;
    state.sceneViewportLoading = true;
    const { rerender } = render(<Chrome />);
    const play = screen.getByTestId("play-preview");
    expect(play.hasAttribute("disabled")).toBe(true);
    expect(play.getAttribute("title")).toBe("Wait for the scene to finish loading");
    state.sceneViewportLoading = false;
    rerender(<Chrome />);
    expect(screen.getByTestId("play-preview").hasAttribute("disabled")).toBe(false);
  });
});

describe("chrome Play Mode", () => {
  it("turns Play into a remembered Simulate when Simulate is chosen", async () => {
    state.canPlay = true;
    const { getAppSettingsSnapshot } = await import("../context/app-settings-context");
    render(<Chrome />);
    fireEvent.click(screen.getByTestId("debug-menu"));
    fireEvent.click(await screen.findByTestId("play-mode-simulate"));
    await waitFor(() => expect(screen.getByTestId("play-preview").textContent).toContain("Simulate"));
    expect(getAppSettingsSnapshot().settings.debuggerDefaults.simulate).toBe(true);
    fireEvent.click(screen.getByTestId("play-preview"));
    expect(state.requestSimulate).toHaveBeenCalledTimes(1);
    expect(state.requestPlay).not.toHaveBeenCalled();
    // Choosing a mode keeps the Debug menu open.
    fireEvent.click(screen.getByTestId("play-mode-play"));
    await waitFor(() => expect(screen.getByTestId("play-preview").textContent).toContain("Play"));
  });
});

describe("chrome Simulation", () => {
  it("turns Simulate into a Stop that ends the running Simulation", () => {
    state.sessionState = { generation: 1, mode: "simulate", lifecycle: "running", quarantined: false, error: null };
    render(<Chrome />);
    expect(screen.queryByTestId("play-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("simulation-session-stop"));
    expect(state.stopSession).toHaveBeenCalledOnce();
  });
});

describe("chrome graph debugger", () => {
  let store: GraphDebugStore | null = null;
  function StoreProbe() {
    store = useGraphDebugStore();
    return null;
  }
  function DebugChrome() {
    return (
      <GraphDebugProvider>
        <StoreProbe />
        <Chrome />
      </GraphDebugProvider>
    );
  }
  const simulate = () => {
    state.sessionState = { generation: 1, mode: "simulate", lifecycle: "running", quarantined: false, error: null };
  };
  const classGraph = (id: string, name: string) => openDocument(id, createDocumentRef("graph", `assets/${name}.class.hasset`));
  const instance = (id: string, label: string) => ({ id, kind: "actor" as const, label });

  afterEach(() => { store = null; });

  it("aims the debugger at the focused Class while a Simulation runs and lists its instances", async () => {
    await createRegistry();
    simulate();
    state.activeId = "door";
    state.documents = [openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF), classGraph("door", "Door")];
    render(<DebugChrome />);
    const target = { kind: "class", classId: "Door" } as const;
    expect(store!.getSnapshot().target).toEqual(target);

    // Nothing is listed yet, so the select reads None and cannot be opened.
    const select = screen.getByRole("combobox", { name: "Debug Instance" });
    expect(select.textContent).toContain("None");
    expect(select.hasAttribute("disabled")).toBe(true);

    act(() => store!.receiveRoster({ target, reset: true, added: [instance("d1", "Front"), instance("d2", "Back")], removed: [] }));
    expect(screen.getByRole("combobox", { name: "Debug Instance" }).textContent).toContain("Front");
    const requests: unknown[] = [];
    store!.subscribeRequest((request) => requests.push(request));

    fireEvent.click(screen.getByRole("combobox", { name: "Debug Instance" }));
    const back = screen.getByRole("option", { name: "Back" });
    fireEvent.pointerDown(back);
    fireEvent.click(back);
    expect(requests.at(-1)).toEqual({ target, instanceId: "d2" });
    expect(screen.getByRole("combobox", { name: "Debug Instance" }).textContent).toContain("Back");

    // The pick falls back when its instance despawns.
    act(() => store!.receiveRoster({ target, reset: false, added: [], removed: ["d2"] }));
    expect(screen.getByRole("combobox", { name: "Debug Instance" }).textContent).toContain("Front");
  });

  it("follows the focused document: another Class retargets, a Scene or a stopped Simulation ends it", async () => {
    await createRegistry();
    simulate();
    state.activeId = "door";
    state.documents = [openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF), classGraph("door", "Door"), classGraph("lamp", "Lamp")];
    const { rerender } = render(<DebugChrome />);
    expect(store!.getSnapshot().target).toEqual({ kind: "class", classId: "Door" });

    state.activeId = "lamp";
    rerender(<DebugChrome />);
    expect(store!.getSnapshot().target).toEqual({ kind: "class", classId: "Lamp" });

    state.activeId = CONTENT_BROWSER_ID;
    rerender(<DebugChrome />);
    expect(store!.getSnapshot().target).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Debug Instance" })).toBeNull();

    state.activeId = "door";
    state.sessionState = { generation: 1, mode: null, lifecycle: "idle", quarantined: false, error: null };
    rerender(<DebugChrome />);
    expect(store!.getSnapshot().target).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Debug Instance" })).toBeNull();
  });

  it.each([
    ["behaviour-tree", { kind: "behaviourTree", assetGuid: "asset-guid" }],
    ["anim-graph", { kind: "animationGraph", assetGuid: "asset-guid" }],
  ] as const)("aims the debugger at the focused %s asset's components, by the asset's guid", async (kind, target) => {
    await createRegistry();
    simulate();
    state.activeId = "asset";
    state.documents = [openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF), openDocument("asset", createDocumentRef(kind, "assets/Guard.hasset"))];
    vi.spyOn(state.registry!, "getByPath").mockReturnValue({ header: { guid: "asset-guid" } } as unknown as ReturnType<AssetRegistry["getByPath"]>);
    render(<DebugChrome />);
    expect(store!.getSnapshot().target).toEqual(target);
    act(() => store!.receiveRoster({ target, reset: true, added: [{ id: "c1", kind: "component", label: "Guard" }], removed: [] }));
    expect(screen.getByRole("combobox", { name: "Debug Instance" }).textContent).toContain("Guard");
  });

  it("offers no select for a Class that never has instances", async () => {
    const registry = await createRegistry();
    void registry;
    simulate();
    state.activeId = "helpers";
    state.documents = [openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF), classGraph("helpers", "Helpers")];
    vi.spyOn(state.registry!, "list").mockReturnValue([
      { path: "assets/Helpers.class.hasset", header: { type: "Class", name: "Helpers", parentClass: "FunctionLibrary" } },
    ] as unknown as ReturnType<AssetRegistry["list"]>);
    render(<DebugChrome />);
    expect(store!.getSnapshot().target).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Debug Instance" })).toBeNull();
  });
});

describe("chrome Compile", () => {
  const issue = (assetGuid: string, message: string): Diagnostic => ({
    severity: "error",
    code: "pin.missing_input",
    message,
    assetGuid,
    graphId: assetGuid,
    nodeId: "n1",
  });

  it("shows the focused class's diagnostics only, not other classes' errors", async () => {
    state.activeId = "hero";
    state.documents = [
      openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
      openDocument("hero", createDocumentRef("graph", "assets/Hero.class.hasset")),
      openDocument("villain", createDocumentRef("graph", "assets/Villain.class.hasset")),
    ];
    // Compile covers the project, so it returns every class's validation.
    state.compileDiagnostics = [
      issue("assets/Villain.class.hasset", "villain problem"),
      issue("assets/Hero.class.hasset", "hero problem"),
    ];
    render(<Chrome />);

    fireEvent.click(screen.getByTestId("compile-graph"));

    await waitFor(() => expect(state.setDiagnostics).toHaveBeenCalledOnce());
    expect(state.setDiagnostics.mock.calls[0]![0]).toEqual([issue("assets/Hero.class.hasset", "hero problem")]);
  });

  it("reports no errors for a clean focused class while another class has some", async () => {
    state.activeId = "hero";
    state.documents = [
      openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
      openDocument("hero", createDocumentRef("graph", "assets/Hero.class.hasset")),
    ];
    state.compileDiagnostics = [issue("assets/Villain.class.hasset", "villain problem")];
    render(<Chrome />);

    fireEvent.click(screen.getByTestId("compile-graph"));

    await waitFor(() => expect(state.setDiagnostics).toHaveBeenCalledOnce());
    expect(state.setDiagnostics).toHaveBeenCalledWith([]);
  });
});

describe("chrome document icons", () => {
  it("allows Close All when Content Browser is the only visible tab and a background sheet is dirty", () => {
    state.activeId = CONTENT_BROWSER_ID;
    state.documents = [
      openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
      { ...openDocument("object", createDocumentRef("data-tree", "assets/Sword.datatree.hasset")), background: true, dirty: true },
    ];
    const closeAll = vi.fn();
    render(<Chrome onCloseAllDocuments={closeAll} />);
    expect(screen.getAllByTestId("document-tab")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.queryByRole("menuitemradio", { name: /Sword/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Open Tab(s)" }));
    expect(closeAll).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps background sheet edits out of navigation until revealed, while Save includes them (phone=%s)", (phone) => {
    state.phone = phone;
    const object = {
      ...openDocument("object", createDocumentRef("data-tree", "assets/Sword.datatree.hasset")),
      background: true,
      dirty: true,
    };
    state.documents = [
      openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
      openDocument("first", createDocumentRef("data-tree", "assets/Weapons.datatree.hasset")),
      object,
    ];
    const view = render(<Chrome />);
    expect((screen.getByTestId("save-all-project") as HTMLButtonElement).disabled).toBe(false);
    if (!phone) expect(screen.getAllByTestId("document-tab")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    expect(screen.queryByRole("menuitemradio", { name: /Sword/ })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Weapons/ })).toBeTruthy();

    // Explicit Open Object promotes the same canonical record; it keeps dirty state.
    object.background = false;
    view.rerender(<Chrome />);
    expect(screen.getByRole("menuitemradio", { name: /Sword/ })).toBeTruthy();
    expect(within(screen.getByRole("menuitemradio", { name: /Sword/ })).getByLabelText("Unsaved Changes")).toBeTruthy();
    if (!phone) expect(screen.getAllByTestId("document-tab")).toHaveLength(3);
  });

  it.each([false, true])(
    "shares class lookups and refreshes inherited icons on registry updates (phone=%s)",
    async (phone) => {
      state.phone = phone;
      const registry = await createRegistry();
      for (const [id, name, parentClass] of [
        ["base", "Shared Base", "Actor"],
        ["first", "First", "base"],
        ["second", "Second", "base"],
      ]) {
        await registry.createAsset("project", `${id}.class.hasset`, {
          guid: id!,
          name: name!,
          type: "Class",
          parentClass,
          version: 1,
          dependencies: [],
          payload: {},
          chunks: [],
        });
      }
      state.documents = [
        openDocument(CONTENT_BROWSER_ID, CONTENT_BROWSER_REF),
        openDocument(
          "scene",
          createDocumentRef("scene", "assets/main.scene.hasset"),
        ),
        openDocument(
          "first",
          createDocumentRef("graph", "assets/first.class.hasset"),
        ),
        openDocument(
          "second",
          createDocumentRef("graph", "assets/second.class.hasset"),
        ),
      ];
      const list = vi.spyOn(registry, "list");
      const view = render(<Chrome />);
      if (!phone) {
        expect(tabIcon("First Class")).toBe("Actor");
        expect(tabIcon("Second Class")).toBe("Actor");
        expect(screen.getAllByTestId("document-tab")).toHaveLength(4);
      }
      fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^First/ })),
      ).toBe("Actor");
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^Second/ })),
      ).toBe("Actor");
      expect(list.mock.calls.length).toBeLessThanOrEqual(1);

      // Resaved with another parent: the registry reindexes a new header.
      await registry.deleteAsset("base");
      await registry.createAsset("project", "base.class.hasset", {
        guid: "base",
        name: "Shared Base",
        type: "Class",
        parentClass: "ActorComponent",
        version: 1,
        dependencies: [],
        payload: {},
        chunks: [],
      });
      state.documents[2]!.dirty = true;
      state.errorCount = 2;
      list.mockClear();
      view.rerender(<Chrome />);
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^First/ })),
      ).toBe("ActorComponent");
      expect(
        typeIcon(screen.getByRole("menuitemradio", { name: /^Second/ })),
      ).toBe("ActorComponent");
      expect(screen.getByLabelText("Unsaved Changes")).toBeTruthy();
      if (!phone) {
        expect(tabIcon("First Class *")).toBe("ActorComponent");
        expect(tabIcon("Second Class")).toBe("ActorComponent");
      }
      expect(list.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("uses indexed asset types and missing-asset fallbacks without enumerating non-Class assets", async () => {
    const registry = await createRegistry();
    await registry.createAsset("project", "sheet.texture.hasset", {
      guid: "sheet",
      name: "Sheet",
      type: "Sprite",
      version: 1,
      dependencies: [],
      payload: {},
      chunks: [],
    });
    state.documents = [
      openDocument(
        "sheet",
        createDocumentRef("texture", "assets/sheet.texture.hasset"),
      ),
      openDocument(
        "missing",
        createDocumentRef("texture", "assets/missing.texture.hasset"),
      ),
    ];
    const list = vi.spyOn(registry, "list");
    const view = render(<Chrome />);
    expect(tabIcon("Sheet.texture Texture")).toBe("Sprite");
    expect(tabIcon("Missing.texture Texture")).toBe("Texture");
    expect(list).not.toHaveBeenCalled();

    state.registry = null;
    view.rerender(<Chrome />);
    expect(tabIcon("Sheet.texture Texture")).toBe("Texture");
    expect(list).not.toHaveBeenCalled();
  });
});
