import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  normalizeParticleSystemPayload,
  type ParticleLibrary,
  type ParticleSystemPayload,
} from "@babylonslate/assets";
import {
  createDefaultParticleGraphDocument,
  type ParticleGraphDocument,
} from "@babylonslate/particle-graph";
import { ParticleSystemEditor, ParticleSystemPreview } from "./particle-system-panels";

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

const GRAPH_PATH = "assets/Embers.particlegraph.babasset";

const harness = vi.hoisted(() => ({
  loadAssetDocument: vi.fn(),
  openDocuments: [] as Array<{ ref: { path: string }; content: unknown }>,
  services: [] as Array<{
    setLibrary: ReturnType<typeof vi.fn>;
    updateLibrary: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@babylonslate/render", () => {
  class ParticleService {
    private state: string | null = null;
    setPaused = vi.fn();
    setLibrary = vi.fn();
    libraryChangeTier = () => "live";
    updateLibrary = vi.fn(() => ({ tier: "live" }));
    handleCommand = vi.fn(() => {
      this.state = "playing";
    });
    playbackState = () => this.state;
    previewStats = () => ({ active: 0, capacity: 0, backend: "none", approximate: false });
    dispose = vi.fn();
    constructor() {
      harness.services.push(this);
    }
  }
  return {
    ParticleService,
    createParticlePreviewScene: () => ({ scene: {}, dispose: vi.fn() }),
    createMaterialPreviewPresenter: () => ({ present: vi.fn(), dispose: vi.fn() }),
    createParticleMaterialResolver: () => ({ acquire: vi.fn(), dispose: vi.fn() }),
    resourceCacheForEngine: () => ({}),
    acquireMaterialTexture: vi.fn(),
    installTextureBytes: (bytes: ReadonlyMap<string, Uint8Array>) => bytes,
  };
});
vi.mock("../context/play-context", () => {
  const engine = {};
  const play = { ensureSharedEngine: () => engine };
  return { useOptionalPlay: () => play };
});
vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "em-1", name: "Sparks", type: "ParticleEmitter" },
          path: "assets/Sparks.emitter.babasset",
        },
        {
          header: { guid: "em-2", name: "Smoke", type: "ParticleEmitter" },
          path: "assets/Smoke.emitter.babasset",
        },
        {
          header: { guid: "pg-1", name: "Embers", type: "ParticleGraph" },
          path: GRAPH_PATH,
        },
        {
          header: { guid: "mat-1", name: "SparksMat", type: "Material" },
          path: "assets/SparksMat.material.babasset",
        },
      ],
    },
    openDocuments: harness.openDocuments,
    loadAssetDocument: harness.loadAssetDocument,
  }),
}));

afterEach(() => {
  cleanup();
  harness.loadAssetDocument.mockReset();
  harness.openDocuments.length = 0;
  harness.services.length = 0;
});

function renderEditor(initial: ParticleSystemPayload) {
  let current = initial;
  function Harness() {
    const [payload, setPayload] = useState(initial);
    current = payload;
    return (
      <ParticleSystemEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={(next) => setPayload(normalizeParticleSystemPayload(next))}
      />
    );
  }
  render(<Harness />);
  return { read: () => current };
}

async function pickEmitter(guid: string) {
  await waitFor(() => expect(screen.getByTestId(`search-item-${guid}`)).toBeTruthy());
  fireEvent.click(screen.getByTestId(`search-item-${guid}`));
}

function slotIcon(index: number): string | null {
  return (
    screen
      .getByTestId(`particle-system-emitter-${index}`)
      .querySelector("[data-type-icon]")
      ?.getAttribute("data-type-icon") ?? null
  );
}

describe("ParticleSystemEditor", () => {
  it("adds the same emitter to two slots and stops adding at eight", async () => {
    const editor = renderEditor(createDefaultParticleSystemPayload());
    fireEvent.click(screen.getByTestId("particle-system-emitters-add"));
    await pickEmitter("em-1");
    fireEvent.click(screen.getByTestId("particle-system-emitters-add"));
    await pickEmitter("em-1");
    expect(editor.read().emitterGuids).toEqual(["em-1", "em-1"]);
    cleanup();

    renderEditor({
      ...createDefaultParticleSystemPayload(),
      emitterGuids: Array.from({ length: 8 }, () => "em-1"),
    });
    expect(
      (screen.getByTestId("particle-system-emitters-add") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("replaces a slot without offering None and flags a missing emitter", async () => {
    const editor = renderEditor({
      ...createDefaultParticleSystemPayload(),
      emitterGuids: ["gone", "em-1"],
    });
    expect(screen.getByTestId("particle-system-emitter-0").textContent).toBe("Missing Emitter");
    fireEvent.click(screen.getByTestId("particle-system-emitter-0"));
    await waitFor(() => expect(screen.getByTestId("search-item-em-2")).toBeTruthy());
    expect(screen.queryByText("None")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-em-2"));
    expect(editor.read().emitterGuids).toEqual(["em-2", "em-1"]);
  });

  it("offers Basic emitters and Particle Graphs as slots and shows each slot's kind", async () => {
    const editor = renderEditor({
      ...createDefaultParticleSystemPayload(),
      emitterGuids: ["em-1"],
    });
    fireEvent.click(screen.getByTestId("particle-system-emitters-add"));
    await waitFor(() => expect(screen.getByTestId("search-item-pg-1")).toBeTruthy());
    expect(screen.getByTestId("search-item-em-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-mat-1")).toBeNull();
    await pickEmitter("pg-1");
    expect(editor.read().emitterGuids).toEqual(["em-1", "pg-1"]);

    expect(screen.getByText("Basic Particle Emitter")).toBeTruthy();
    expect(screen.getByText("Particle Graph")).toBeTruthy();
    expect(slotIcon(0)).toBe("ParticleEmitter");
    expect(slotIcon(1)).toBe("ParticleGraph");
  });
});

describe("ParticleSystemPreview", () => {
  const system = { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] };
  const emitter = createDefaultParticleEmitterPayload();
  const withMaterial = { ...emitter, render: { ...emitter.render, materialGuid: "mat-1" } };
  const graph = (capacity = 256): ParticleGraphDocument => {
    const document = { ...createDefaultParticleGraphDocument("Embers"), materialGuid: "mat-2" };
    return { ...document, settings: { ...document.settings, capacity } };
  };
  /** Emitter Output loses its Particle input, a validator error. */
  const brokenGraph = (): ParticleGraphDocument => {
    const document = graph();
    return {
      ...document,
      edges: document.edges.filter((edge) => edge.targetNodeId !== "output"),
    };
  };
  const renderPreview = (payload: ParticleSystemPayload) =>
    render(<ParticleSystemPreview payload={payload as unknown as Record<string, unknown>} />);
  const appliedLibraries = (): ParticleLibrary[] => {
    const service = harness.services[0]!;
    return [...service.setLibrary.mock.calls, ...service.updateLibrary.mock.calls].map(
      ([library]) => library as ParticleLibrary,
    );
  };

  it("recovers a failed emitter document read without reopening the system", async () => {
    harness.loadAssetDocument.mockRejectedValueOnce(new Error("Emitter read failed"));
    harness.loadAssetDocument.mockResolvedValue(withMaterial);
    renderPreview(system);
    expect(await screen.findByText("Preview Failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("particle-system-preview-canvas")).toBeTruthy(),
    );
    expect(screen.queryByText("Preview Failed")).toBeNull();
    expect(harness.loadAssetDocument).toHaveBeenCalledWith(
      "particle-emitter",
      "assets/Sparks.emitter.babasset",
    );
  });

  it("names a loaded emitter without a Material instead of drawing a blank canvas", async () => {
    harness.loadAssetDocument.mockResolvedValue(emitter);
    renderPreview(system);
    expect(await screen.findByText("No Material")).toBeTruthy();
    expect(screen.queryByTestId("particle-system-preview-canvas")).toBeNull();
  });

  it("previews a Basic slot and a Particle Graph slot together", async () => {
    harness.loadAssetDocument.mockImplementation(async (kind: string) =>
      kind === "particle-graph" ? graph() : withMaterial,
    );
    renderPreview({ ...system, emitterGuids: ["em-1", "pg-1"] });
    await waitFor(() => expect(harness.services).toHaveLength(1));
    expect(harness.loadAssetDocument).toHaveBeenCalledWith("particle-graph", GRAPH_PATH);
    const [library] = appliedLibraries();
    expect([...library!.emitters.values()].map((entry) => entry.kind)).toEqual([
      "basic",
      "graph",
    ]);
  });

  it("explains a Particle Graph slot that has never validated instead of starting the preview", async () => {
    harness.loadAssetDocument.mockResolvedValue(brokenGraph());
    renderPreview({ ...system, emitterGuids: ["pg-1"] });
    expect(await screen.findByTestId("particle-preview-graph-errors")).toBeTruthy();
    expect(screen.getByText("Graph Has Errors")).toBeTruthy();
    expect(harness.services).toHaveLength(0);
  });

  it("keeps playing a graph's last valid build while its open tab has errors", async () => {
    const payload = { ...system, emitterGuids: ["pg-1"] };
    harness.openDocuments.push({ ref: { path: GRAPH_PATH }, content: graph() });
    const view = renderPreview(payload);
    await waitFor(() => expect(harness.services).toHaveLength(1));

    harness.openDocuments[0] = { ref: { path: GRAPH_PATH }, content: brokenGraph() };
    view.rerender(
      <ParticleSystemPreview payload={payload as unknown as Record<string, unknown>} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("particle-preview-notice").textContent).toMatch(
        /^Graph has \d+ errors?\. Preview shows the last valid build\.$/,
      ),
    );
    expect(screen.queryByTestId("particle-preview-graph-errors")).toBeNull();
    // The broken graph never reached the service.
    for (const library of appliedLibraries()) {
      const entry = library.emitters.get("pg-1");
      expect(entry?.kind === "graph" && entry.document.edges.length).toBe(graph().edges.length);
    }

    harness.openDocuments[0] = { ref: { path: GRAPH_PATH }, content: graph(512) };
    view.rerender(
      <ParticleSystemPreview payload={payload as unknown as Record<string, unknown>} />,
    );
    await waitFor(() => expect(screen.queryByTestId("particle-preview-notice")).toBeNull());
    const latest = appliedLibraries().at(-1)!.emitters.get("pg-1");
    expect(latest?.kind === "graph" && latest.document.settings.capacity).toBe(512);
  });
});
