import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import { createDefaultScene, engineCommandBus } from "@haptic/core";
import { OutputLogPanel } from "../panels/output-log-panel";
import { enterPhoneDockLayout } from "../shell/phone-dock-layout";
import { DocumentWorkspaceProvider } from "./document-workspace-context";
import {
  PlayProvider,
  useOptionalPlay,
  useOutputLog,
  usePlay,
} from "./play-context";

const host = vi.hoisted(() => {
  const diagnostics = new Set<(line: string) => void>();
  const noProject: Record<string, unknown> = {
    onSessionDiagnostic: (listener: (line: string) => void) => {
      diagnostics.add(listener);
      return () => {
        diagnostics.delete(listener);
      };
    },
  };
  return {
    diagnostics,
    noProject,
    documents: noProject,
    validation: { setDiagnostics: vi.fn(), setFocusDiagnostic: vi.fn() },
    settings: {
      settings: { debuggerDefaults: { overlayStats: false } },
      updateDebuggerDefaults: vi.fn(async () => {}),
    },
  };
});

// Session data and settings are external to the subscription boundary under test.
vi.mock("./document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => host.documents));
vi.mock("./validation-context", () => ({
  useValidation: () => host.validation,
}));
vi.mock("./app-settings-context", () => ({
  useAppSettings: () => host.settings,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  host.documents = host.noProject;
});

it("delivers logs only to their subscribers while Play controls stay live", async () => {
  const renders = { play: 0, optional: 0, log: 0 };
  let controls!: ReturnType<typeof usePlay>;
  function PlayConsumer() {
    controls = usePlay();
    renders.play += 1;
    return (
      <output data-testid="play-controls">
        {String(controls.overlayStats)}
      </output>
    );
  }
  function OptionalConsumer() {
    const play = useOptionalPlay();
    renders.optional += 1;
    return (
      <output data-testid="optional-controls">
        {String(play?.overlayStats)}
      </output>
    );
  }
  function LogConsumer() {
    const { lines } = useOutputLog();
    renders.log += 1;
    return <output data-testid="logs">{lines.join("\n")}</output>;
  }
  const view = render(
    <PlayProvider>
      <PlayConsumer />
      <OptionalConsumer />
      <LogConsumer />
    </PlayProvider>,
  );
  expect(screen.getByTestId("play-controls").textContent).toBe("false");
  const initial = { ...renders };
  act(() =>
    engineCommandBus.dispatch({
      type: "log",
      message: "Engine Line",
    }),
  );
  act(() => {
    for (const listener of host.diagnostics) listener("Session Line");
  });
  act(() => controls.appendLog("Utility Line"));
  // Lines from separate events within one frame commit together, in arrival order.
  await waitFor(() => expect(screen.getByTestId("logs").textContent).toBe(
    "[Engine] Engine Line\nSession Line\nUtility Line",
  ));
  expect(renders.log).toBe(initial.log + 1);
  expect(renders.play).toBe(initial.play);
  expect(renders.optional).toBe(initial.optional);

  const beforeControlChange = { ...renders };
  act(() => controls.setOverlayStats(true));
  expect(screen.getByTestId("play-controls").textContent).toBe("true");
  expect(screen.getByTestId("optional-controls").textContent).toBe("true");
  expect(renders.play).toBeGreaterThan(beforeControlChange.play);
  expect(renders.log).toBe(beforeControlChange.log);
  view.unmount();
  expect(host.diagnostics.size).toBe(0);
});

it("keeps Play controls stable across document edits while Play saves the newest dirty documents", async () => {
  const scene = {
    id: "scene:assets/Main.scene.hasset",
    ref: { kind: "scene", path: "assets/Main.scene.hasset", label: "Main" },
    content: createDefaultScene(),
    dirty: false,
  };
  const hero = {
    id: "graph:assets/Hero.class.hasset",
    ref: { kind: "graph", path: "assets/Hero.class.hasset", label: "Hero Class" },
    content: { nodes: [], edges: [] },
    dirty: false,
  };
  // Saving never finishes, so the prepare dialog stays in its Saving phase.
  const saveAll = vi.fn(() => new Promise<boolean>(() => {}));
  const clean = {
    ...host.noProject,
    openDocuments: [scene, hero],
    activeDocumentId: scene.id,
    saveAll,
  };
  host.documents = clean;
  let controls!: ReturnType<typeof usePlay>;
  function PlayConsumer() {
    controls = usePlay();
    return null;
  }
  const view = render(
    <PlayProvider>
      <PlayConsumer />
    </PlayProvider>,
  );
  const beforeEdit = controls;

  const editedHero = { ...hero, dirty: true };
  host.documents = {
    ...clean,
    openDocuments: [scene, editedHero],
    dirtyDocuments: [editedHero],
  };
  view.rerender(
    <PlayProvider>
      <PlayConsumer />
    </PlayProvider>,
  );
  expect(controls).toBe(beforeEdit);

  // A Play button rendered before the edit still sees the edited graph, and
  // asks before saving it.
  await act(async () => {
    void beforeEdit.requestPlay();
  });
  expect(saveAll).not.toHaveBeenCalled();
  expect(screen.getByTestId("play-unsaved-names").textContent).toBe("Hero Class");
  await act(async () => {
    fireEvent.click(screen.getByTestId("play-unsaved-save"));
  });
  expect(saveAll).toHaveBeenCalledTimes(1);
  const dialog = screen.getByTestId("play-prepare-dialog");
  expect(dialog.textContent).toContain("Saving 1 Document");
  expect(dialog.textContent).toContain("Hero Class");
});

it("keeps Play stopped and the preparation error visible even with fixture injection enabled", async () => {
  const scene = {
    id: "scene:assets/Main.scene.hasset",
    ref: { kind: "scene", path: "assets/Main.scene.hasset", label: "Main" },
    content: createDefaultScene(),
    dirty: false,
  };
  host.documents = { ...host.noProject, openDocuments: [scene], activeDocumentId: scene.id };
  let controls!: ReturnType<typeof usePlay>;
  function Consumer() {
    controls = usePlay();
    const { lines } = useOutputLog();
    return <output data-testid="logs">{lines.join("\n")}</output>;
  }
  render(<PlayProvider><Consumer /></PlayProvider>);

  await act(async () => { await controls.requestPlay({ injectFixtureThrow: true }); });

  expect(controls.playing).toBe(false);
  expect(controls.preparing).toBe(false);
  expect(screen.queryByTestId("play-prepare-dialog")).toBeNull();
  await waitFor(() => expect(screen.getByTestId("logs").textContent).toBe("Play preparation failed: No project catalog is available."));
});

const MAIN_SCENE_ID = "scene:assets/Main.scene.hasset";
const OTHER_SCENE_ID = "scene:assets/Other.scene.hasset";

it.each([
  { where: "visible in the active Scene document", documentId: MAIN_SCENE_ID, dialog: false },
  {
    where: "behind another tab in its dock group", documentId: MAIN_SCENE_ID, dialog: true,
    arrange: (api: DockviewApi) => api.getPanel("compiler-results")!.api.setActive(),
  },
  {
    // The phone shows the Output Log as its one window, then the user picks the Viewport.
    where: "outside the one window a phone shows", documentId: MAIN_SCENE_ID, dialog: true,
    arrange: (api: DockviewApi) => {
      enterPhoneDockLayout(api);
      api.getPanel("viewport")!.api.setActive();
    },
  },
  { where: "in a background Scene document tab", documentId: OTHER_SCENE_ID, dialog: true },
  { where: "not open", documentId: null, dialog: true },
])("shows a Play preparation failure in a dialog only when no Output Log is visible: $where", async ({ documentId, dialog, arrange }) => {
  const scene = (id: string, label: string) => ({
    id,
    ref: { kind: "scene", path: id.slice("scene:".length), label },
    content: createDefaultScene(),
    dirty: false,
  });
  host.documents = {
    ...host.noProject,
    openDocuments: [scene(MAIN_SCENE_ID, "Main"), scene(OTHER_SCENE_ID, "Other")],
    activeDocumentId: MAIN_SCENE_ID,
  };
  let controls!: ReturnType<typeof usePlay>;
  function Controls() {
    controls = usePlay();
    const { lines } = useOutputLog();
    return <output data-testid="logs">{lines.join("\n")}</output>;
  }
  const onReady = ({ api }: DockviewReadyEvent) => {
    api.layout(1200, 800);
    api.addPanel({ id: "viewport", component: "window", title: "Viewport" });
    api.addPanel({ id: "output-log", component: "output-log", title: "Output Log", position: { referencePanel: "viewport", direction: "below" } });
    api.addPanel({ id: "compiler-results", component: "window", title: "Compiler Results", position: { referencePanel: "output-log", direction: "within" } });
    api.getPanel("output-log")!.api.setActive();
    arrange?.(api);
  };
  render(
    <PlayProvider>
      <Controls />
      {documentId ? (
        <DocumentWorkspaceProvider documentId={documentId}>
          <DockviewReact components={{ "output-log": OutputLogPanel, window: () => null }} onReady={onReady} />
        </DocumentWorkspaceProvider>
      ) : null}
    </PlayProvider>,
  );

  await act(async () => { await controls.requestPlay(); });
  expect(controls.playing).toBe(false);
  await waitFor(() => expect(screen.getByTestId("logs").textContent).toBe("Play preparation failed: No project catalog is available."));
  if (!dialog) {
    expect(screen.queryByRole("dialog")).toBeNull();
    return;
  }
  const failure = screen.getByRole("dialog", { name: "Play Failed" });
  expect(failure.textContent).toContain("No project catalog is available.");
  await act(async () => { fireEvent.click(within(failure).getByRole("button", { name: "Close" })); });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("cancels or plays without saving from the Unsaved Changes prompt", async () => {
  const scene = {
    id: "scene:assets/Main.scene.hasset",
    ref: { kind: "scene", path: "assets/Main.scene.hasset", label: "Main" },
    content: createDefaultScene(),
    dirty: true,
  };
  const saveAll = vi.fn(async () => true);
  host.documents = {
    ...host.noProject,
    openDocuments: [scene],
    dirtyDocuments: [scene],
    activeDocumentId: scene.id,
    saveAll,
  };
  let controls!: ReturnType<typeof usePlay>;
  function PlayConsumer() {
    controls = usePlay();
    return null;
  }
  render(
    <PlayProvider>
      <PlayConsumer />
    </PlayProvider>,
  );
  await act(async () => {
    void controls.requestPlay();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("play-unsaved-cancel"));
  });
  // The dialog unmounts after its closing animation.
  await waitFor(() => expect(screen.queryByTestId("play-unsaved-dialog")).toBeNull());
  // Cancel starts no Play session.
  expect(controls.sessionState.generation).toBe(0);
  await act(async () => {
    void controls.requestPlay();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("play-unsaved-skip"));
  });
  await waitFor(() => expect(screen.queryByTestId("play-unsaved-dialog")).toBeNull());
  // Play Without Saving starts a session from the unsaved documents.
  expect(controls.sessionState.generation).toBe(1);
  expect(saveAll).not.toHaveBeenCalled();
});


it("cancels Simulation before save admission drains without touching its scene or starting a viewport", async () => {
  const scene = {
    id: "scene:assets/Main.scene.hasset",
    ref: { kind: "scene", path: "assets/Main.scene.hasset", label: "Main" },
    content: createDefaultScene(), dirty: true,
  };
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  const release = vi.fn(() => resolveReady(false));
  const lockAuthoring = vi.fn(() => () => {});
  const saveAll = vi.fn(async () => true);
  host.documents = {
    ...host.noProject, openDocuments: [scene], dirtyDocuments: [scene], activeDocumentId: scene.id,
    lockAuthoringWrites: () => ({ ready, release }), lockAuthoring, saveAll,
  };
  let controls!: ReturnType<typeof usePlay>;
  function Controls() { controls = usePlay(); return null; }
  render(<PlayProvider><Controls /></PlayProvider>);
  const suspend = vi.fn(async () => {});
  act(() => { controls.registerSimulationViewport({ documentId: scene.id, host: document.body, suspend, restore() {} }); });
  let preparation!: Promise<void>;
  act(() => { preparation = controls.requestSimulate(); });
  expect(controls.sessionState.mode).toBe("simulate");
  expect(lockAuthoring).not.toHaveBeenCalled();
  await act(async () => { await controls.sessionOwner.stop(); await preparation; });
  expect(release).toHaveBeenCalled();
  expect(lockAuthoring).not.toHaveBeenCalled();
  expect(saveAll).not.toHaveBeenCalled();
  expect(suspend).not.toHaveBeenCalled();
  expect(scene.dirty).toBe(true);
  expect(controls.preparing).toBe(false);
  expect(controls.canSimulate).toBe(true);
});
