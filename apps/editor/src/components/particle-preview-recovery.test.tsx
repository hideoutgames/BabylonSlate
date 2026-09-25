import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  type ParticleEmitterPayload,
} from "@babylonslate/assets";
import type { ParticleServiceDiagnostic } from "@babylonslate/render";
import { ParticlePreviewCanvas } from "./particle-preview-canvas";
import { systemPreviewLibrary } from "../lib/play-particles";

const harness = vi.hoisted(() => ({
  createScene: vi.fn(),
  services: [] as Array<{
    setPaused: ReturnType<typeof vi.fn>;
    updateLibrary: ReturnType<typeof vi.fn>;
    handleCommand: ReturnType<typeof vi.fn>;
    systems: number;
    state: string | null;
  }>,
  /** Diagnostics the next assign reports; a missing Material leaves no system. */
  assignDiagnostics: [] as ParticleServiceDiagnostic[],
  /** The tier the service reports for the next library edit. */
  tier: "live",
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
    stats = () => ({ systems: this.systems, playing: this.systems, gpu: true, gpuSystems: this.systems });
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
vi.mock("../context/document-context", () => {
  const documents = {
    collectPlayMaterialLibrary: async () => ({
      documents: new Map(),
      functions: new Map(),
      textureGuids: [],
    }),
    collectPlayTextureBytes: async () => new Map(),
  };
  return { useDocuments: () => documents };
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

function preview(emitter: ParticleEmitterPayload = withMaterial) {
  return (
    <ParticlePreviewCanvas
      library={systemPreviewLibrary(
        { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] },
        new Map([["emitter", { kind: "basic", payload: emitter }]]),
      )}
      systemGuid="preview-sys"
      testId="particle-canvas"
    />
  );
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
