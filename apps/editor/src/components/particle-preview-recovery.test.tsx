import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  type IndexedAsset,
  type ParticleEmitterPayload,
  type ParticleLibrary,
} from "@babylonslate/assets";
import type { ParticleServiceDiagnostic } from "@babylonslate/render";
import { ParticlePreviewCanvas } from "./particle-preview-canvas";
import { systemPreviewLibrary } from "../lib/play-particles";

const harness = vi.hoisted(() => ({
  createScene: vi.fn(),
  services: [] as Array<{
    setPaused: ReturnType<typeof vi.fn>;
    updateLibrary: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    handleCommand: ReturnType<typeof vi.fn>;
    /** A diagnostic that arrives after the call that caused it (an async Material failure). */
    report: (diagnostic: ParticleServiceDiagnostic) => void;
    systems: number;
    state: string | null;
  }>,
  /** Diagnostics the next assign reports; a missing Material leaves no system. */
  assignDiagnostics: [] as ParticleServiceDiagnostic[],
  /** The tier the service reports for the next library edit. */
  tier: "live",
  /** Textures the Material samples: saved registry entries and the bytes Play resolves. */
  textureGuids: [] as string[],
  textures: new Map<string, IndexedAsset>(),
  textureBytes: new Map<string, Uint8Array>(),
  registryVersion: 0,
  /** Each scene's Material resolver options; `acquireTexture` returns the bound bytes. */
  resolvers: [] as Array<{ acquireTexture: (guid: string) => unknown }>,
}));

vi.mock("@babylonslate/render", () => {
  class ParticleService {
    private readonly onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void;
    systems = 0;
    state: string | null = null;
    setPaused = vi.fn();
    setLibrary = vi.fn();
    libraryChangeTier = () => harness.tier;
    updateLibrary = vi.fn(() => ({ tier: harness.tier }));
    handleCommand = vi.fn(() => {
      for (const diagnostic of harness.assignDiagnostics) this.onDiagnostic?.(diagnostic);
      const failed = harness.assignDiagnostics.length > 0;
      this.systems = failed ? 0 : 1;
      this.state = failed ? "failed" : "playing";
    });
    playbackState = () => this.state;
    report = (diagnostic: ParticleServiceDiagnostic) => this.onDiagnostic?.(diagnostic);
    stats = () => ({
      systems: this.systems,
      playing: this.systems,
      gpu: true,
      gpuSystems: this.systems,
      graphSystems: 0,
    });
    previewStats = () => ({ active: 12, capacity: 256, backend: "gpu", approximate: true });
    dispose = vi.fn();
    constructor(options: { onDiagnostic?: (diagnostic: ParticleServiceDiagnostic) => void }) {
      this.onDiagnostic = options.onDiagnostic;
      harness.services.push(this);
    }
  }
  return {
    ParticleService,
    createParticlePreviewScene: harness.createScene,
    createMaterialPreviewPresenter: () => ({ present: vi.fn(), dispose: vi.fn() }),
    createParticleMaterialResolver: (options: { acquireTexture: (guid: string) => unknown }) => {
      harness.resolvers.push(options);
      return { acquire: vi.fn(), dispose: vi.fn() };
    },
    resourceCacheForEngine: () => ({}),
    acquireMaterialTexture: (_cache: unknown, _guid: string, _engine: unknown, bytes: Uint8Array) => bytes,
    installTextureBytes: (bytes: ReadonlyMap<string, Uint8Array>) => bytes,
  };
});
vi.mock("../context/play-context", () => {
  const engine = {};
  const play = { ensureSharedEngine: () => engine };
  return { useOptionalPlay: () => play };
});
vi.mock("../context/document-context", () => {
  const documents = {
    assetRegistry: { getByGuid: (guid: string) => harness.textures.get(guid) },
    collectPlayMaterialLibrary: async () => ({
      documents: new Map(),
      functions: new Map(),
      textureGuids: [...harness.textureGuids],
    }),
    collectPlayTextureBytes: async () => new Map(harness.textureBytes),
  };
  return { useDocuments: () => ({ ...documents, registryVersion: harness.registryVersion }) };
});

beforeEach(() => {
  harness.createScene.mockImplementation(() => ({ scene: {}, dispose: vi.fn() }));
});

afterEach(() => {
  cleanup();
  harness.createScene.mockReset();
  harness.services.length = 0;
  harness.assignDiagnostics = [];
  harness.tier = "live";
  harness.textureGuids = [];
  harness.textures.clear();
  harness.textureBytes.clear();
  harness.registryVersion = 0;
  harness.resolvers.length = 0;
});

const base = createDefaultParticleEmitterPayload();
const withMaterial: ParticleEmitterPayload = {
  ...base,
  render: { ...base.render, materialGuid: "mat-1" },
};
const withRate = (value: number): ParticleEmitterPayload => ({
  ...withMaterial,
  spawn: { ...withMaterial.spawn, rate: { mode: "constant", value } },
});

function libraryFor(emitter: ParticleEmitterPayload): ParticleLibrary {
  return systemPreviewLibrary(
    { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] },
    new Map([["emitter", { kind: "basic", payload: emitter }]]),
  );
}

function canvas(
  library: ParticleLibrary,
  onDiagnostics?: ComponentProps<typeof ParticlePreviewCanvas>["onDiagnostics"],
) {
  return (
    <ParticlePreviewCanvas
      library={library}
      systemGuid="preview-sys"
      testId="particle-canvas"
      onDiagnostics={onDiagnostics}
    />
  );
}

function preview(emitter: ParticleEmitterPayload = withMaterial) {
  return canvas(libraryFor(emitter));
}

/** A saved Texture registry entry with these KTX2 chunks. */
function savedTexture(payload: Record<string, unknown>, ktx2ChunkIds: string[]): IndexedAsset {
  return {
    rootId: "project",
    path: "assets/albedo.babasset",
    header: {
      chunks: ktx2ChunkIds.map((id) => ({
        id,
        kind: "ktx2",
        mime: "image/ktx2",
        sha256: `sha-${id}`,
        locator: { blob: id },
      })),
      dependencies: [],
      engineVersion: "1",
      guid: "tex-1",
      mode: "thin",
      name: "albedo",
      payload,
      type: "Texture",
      version: 1,
    },
  };
}

describe("Particle preview recovery", () => {
  it("shows renderer failures and retries them into a running preview", async () => {
    harness.createScene.mockImplementationOnce(() => {
      throw new Error("Preview renderer unavailable");
    });
    render(preview());
    expect(await screen.findByText("Preview Failed")).toBeTruthy();
    expect(screen.queryByText("Loading Preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("particle-preview-restart")).toBeTruthy());
    expect(harness.createScene).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Preview Failed")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("particle-preview-count").textContent).toBe("~12 / 256"),
    );
  });

  it("pauses the running preview and restarts it with the same assignment", async () => {
    render(preview());
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const service = harness.services[0]!;
    expect(service.setPaused).toHaveBeenLastCalledWith(true);
    const play = screen.getByRole("button", { name: "Play" });
    expect(play.getAttribute("aria-pressed")).toBe("true");
    const assigns = service.handleCommand.mock.calls.length;
    fireEvent.click(screen.getByTestId("particle-preview-restart"));
    expect(service.handleCommand).toHaveBeenCalledTimes(assigns + 1);
    expect(service.handleCommand.mock.calls.at(-1)![0]).toMatchObject({
      type: "assignParticle",
      particleSystemGuid: "preview-sys",
    });
  });

  it("applies edits the service keeps live at once and waits for ones it re-prepares", async () => {
    const view = render(preview());
    await screen.findByTestId("particle-preview-restart");
    const service = harness.services[0]!;
    view.rerender(preview(withRate(60)));
    expect(service.updateLibrary).toHaveBeenCalledTimes(1);
    // A value edit on a skipped slot re-prepares the whole bundle, so it waits like a rebuild.
    harness.tier = "rebuild";
    view.rerender(preview(withRate(61)));
    expect(service.updateLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("particle-preview-updating")).toBeTruthy();
    await waitFor(() => expect(service.updateLibrary).toHaveBeenCalledTimes(2));
    expect(harness.services).toHaveLength(1);
  });

  it("reports a late diagnostic with the library its run was built from", async () => {
    const onDiagnostics = vi.fn();
    const running = libraryFor(withMaterial);
    const view = render(canvas(running, onDiagnostics));
    await screen.findByTestId("particle-preview-restart");
    const service = harness.services[0]!;
    harness.tier = "rebuild";
    const edited = libraryFor(withRate(61));
    view.rerender(canvas(edited, onDiagnostics));
    // An async Material failure of the running build lands while the edit waits.
    const late: ParticleServiceDiagnostic = {
      code: "particle.apply_failed",
      assetGuid: "emitter",
      message: "Particle Emitter Material failed to build; slot skipped.",
    };
    act(() => service.report(late));
    expect(service.updateLibrary).not.toHaveBeenCalled();
    expect(onDiagnostics.mock.lastCall![0]).toEqual([late]);
    expect(onDiagnostics.mock.lastCall![1]).toBe(running);
    // The rebuild starts a new report for the edited library.
    await waitFor(() => expect(service.updateLibrary).toHaveBeenCalledTimes(1));
    expect(onDiagnostics.mock.lastCall![0]).toEqual([]);
    expect(onDiagnostics.mock.lastCall![1]).toBe(edited);
  });

  it("keeps Restart after a finished Once emitter released its systems", async () => {
    const view = render(preview());
    await screen.findByTestId("particle-preview-restart");
    const service = harness.services[0]!;
    service.systems = 0;
    service.state = "ready-stopped";
    harness.tier = "none";
    view.rerender(preview(withRate(60)));
    // The edit still reaches the service, so Restart replays the released run with it.
    expect(service.updateLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("particle-preview-restart")).toBeTruthy();
    expect(screen.queryByText("Preview Failed")).toBeNull();
  });

  it("binds a sampled Texture's new bytes once its saved header changes", async () => {
    harness.textureGuids = ["tex-1"];
    harness.textures.set("tex-1", savedTexture({ usage: "albedo", ktx2ChunkId: "ktx2-1x1" }, ["ktx2-1x1"]));
    harness.textureBytes.set("tex-1", new Uint8Array([1]));
    const view = render(preview());
    await screen.findByTestId("particle-preview-restart");
    // Encode progress (and any unrelated registry change) keeps the running scene.
    harness.textures.set(
      "tex-1",
      savedTexture({ usage: "albedo", ktx2ChunkId: "ktx2-1x1", compressionState: "encoding" }, ["ktx2-1x1"]),
    );
    harness.registryVersion += 1;
    view.rerender(preview());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(harness.services).toHaveLength(1);
    // Set Usage To Particle was saved and its block-aligned encode committed.
    const aligned = new Uint8Array([4]);
    harness.textureBytes.set("tex-1", aligned);
    harness.textures.set(
      "tex-1",
      savedTexture(
        { usage: "particle", ktx2ChunkId: "ktx2-4x4", compressionState: "compressed" },
        ["ktx2-1x1", "ktx2-4x4"],
      ),
    );
    harness.registryVersion += 1;
    view.rerender(preview());
    await waitFor(() => expect(harness.services).toHaveLength(2));
    expect(harness.services[0]!.dispose).toHaveBeenCalled();
    expect(harness.resolvers.at(-1)!.acquireTexture("tex-1")).toBe(aligned);
  });

  it("names a Material the service could not use", async () => {
    harness.assignDiagnostics = [
      {
        code: "particle.missing_material",
        assetGuid: "emitter",
        message: "Particle Emitter has no usable Material; slot skipped.",
      },
    ];
    render(preview());
    expect(await screen.findByText("No Material")).toBeTruthy();
    expect(screen.getByTestId("particle-canvas")).toBeTruthy();
  });
});
