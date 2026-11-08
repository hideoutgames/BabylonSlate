import { act, cleanup, render, waitFor } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultScene, createEmptyProject } from "@haptic/core";
import { PlayProvider, usePlay } from "./play-context";

// Play presents a running game through PlayOverlay. These stand-ins replace only the boundaries
// below the provider: the GPU Engine, asset preparation, the game worker and the overlay itself.
const host = vi.hoisted(() => {
  const scene = {
    rootId: "project",
    path: "assets/Main.scene.hasset",
    header: { guid: "main-scene", type: "Scene", name: "Main" },
  };
  return {
    scene,
    registry: {
      list: () => [scene],
      getByGuid: (guid: string) => (guid === scene.header.guid ? scene : undefined),
      getByPath: (path: string) => (path === scene.path ? scene : undefined),
    },
    validation: { setDiagnostics: () => {}, setFocusDiagnostic: () => {} },
    settings: {
      settings: { debuggerDefaults: { overlayStats: false } },
      updateDebuggerDefaults: async () => {},
    },
    providerRenders: 0,
    overlay: { renders: 0, changed: [] as string[] },
  };
});

const documents = vi.hoisted(() => ({
  set: null as null | ((update: (current: Record<string, unknown>) => Record<string, unknown>) => void),
}));

vi.mock("./document-context", async () => {
  const { documentContextMock, sharedMockState } = await import("../testing/document-context-mock");
  const project = createEmptyProject("Play");
  project.settings.startupSceneGuid = host.scene.header.guid;
  const state = sharedMockState<Record<string, unknown>>(() => ({
    projectDocument: project,
    assetRegistry: host.registry,
    projectGuid: "project-guid",
    onSessionDiagnostic: () => () => {},
  }));
  return documentContextMock(() => {
    const [value, set] = state.use();
    documents.set = set;
    return value;
  });
});
vi.mock("./validation-context", () => ({
  useValidation: () => {
    // PlayProvider is the only caller in this tree, so this counts its renders.
    host.providerRenders += 1;
    return host.validation;
  },
}));
vi.mock("./app-settings-context", () => ({ useAppSettings: () => host.settings }));
vi.mock("./use-project-rendering", () => {
  const engine = { onContextRestoredObservable: { add: () => null } };
  const rendering = {
    engineRef: { current: engine },
    ownedEngineRef: { current: engine },
    projectEngine: { dispose: () => {} },
    projectEngineState: { phase: "idle", session: null },
    sharedEngineGeneration: 0,
    registerSharedEngine: () => {},
    ensureEngine: () => engine,
    retryRendering: async () => {},
    renderingRetrying: false,
    renderingRetryFailure: null,
    renderingFailureDismissed: false,
    setRenderingFailureDismissed: () => {},
  };
  return { useProjectRendering: () => rendering };
});
vi.mock("../services/game-worker-host", () => ({
  prewarmGameWorker: () => {},
  preloadPrewarmedGameWorkerPhysics: () => {},
}));
vi.mock("../services/play-asset-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/play-asset-sources")>()),
  requiredProjectAssets: () => [],
  playDocumentOverrides: () => new Map(),
  acquirePlayAssetSources: async () => ({
    game: { scenes: new Map([[host.scene.header.guid, createDefaultScene()]]), scripts: [], decodedPayloads: new Map() },
    content: {},
    sources: {},
    diagnostics: [],
    required: [],
    audioChunks: new Map(),
    release: () => {},
  }),
}));
vi.mock("./use-play-content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-play-content")>()),
  preparedPlayContent: () => ({}),
  playAudioAndNavigation: () => ({}),
}));
// The real overlay is `memo(PlayOverlayView)` with the default comparison; this probe is the same
// memo, so it renders again exactly when the provider passes a prop with a new identity.
vi.mock("../components/play-overlay", () => {
  let previous: Record<string, unknown> | null = null;
  return {
    PlayOverlay: memo(function PlayOverlayProbe(props: Record<string, unknown>) {
      host.overlay.renders += 1;
      if (previous) {
        const keys = new Set([...Object.keys(previous), ...Object.keys(props)]);
        host.overlay.changed.push(...[...keys].filter((key) => !Object.is(previous![key], props[key])));
      }
      previous = props;
      return <div data-testid="play-overlay-probe" />;
    }),
  };
});

afterEach(cleanup);

it("keeps the running game's overlay from re-rendering when a document edit re-renders Play", async () => {
  let controls!: ReturnType<typeof usePlay>;
  function Consumer() {
    controls = usePlay();
    return null;
  }
  const view = render(
    <PlayProvider>
      <Consumer />
    </PlayProvider>,
  );
  await act(async () => {
    await controls.requestPlay();
  });
  await waitFor(() => expect(view.queryByTestId("play-overlay-probe")).not.toBeNull());
  // Let the presentation's own effects settle before measuring.
  await act(async () => {});
  const overlayRenders = host.overlay.renders;
  const providerRenders = host.providerRenders;
  host.overlay.changed.length = 0;

  const edited = {
    id: "graph:assets/Hero.class.hasset",
    ref: { kind: "graph", path: "assets/Hero.class.hasset", label: "Hero Class" },
    content: { nodes: [], edges: [] },
    dirty: true,
  };
  act(() => documents.set!((current) => ({ ...current, openDocuments: [edited], dirtyDocuments: [edited] })));
  act(() => documents.set!((current) => ({ ...current, openDocuments: [{ ...edited }], dirtyDocuments: [{ ...edited }] })));

  expect(host.providerRenders).toBeGreaterThan(providerRenders);
  expect(host.overlay.changed).toEqual([]);
  expect(host.overlay.renders).toBe(overlayRenders);
});
