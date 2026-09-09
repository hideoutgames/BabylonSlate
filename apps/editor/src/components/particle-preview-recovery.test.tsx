import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
} from "@babylonslate/assets";
import { ParticlePreviewCanvas } from "./particle-preview-canvas";
import { systemPreviewLibrary } from "../lib/play-particles";

const createScene = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Preview renderer unavailable");
  }),
);
vi.mock("@babylonslate/render", () => ({
  createParticlePreviewScene: createScene,
  createMaterialPreviewPresenter: vi.fn(),
  createParticleMaterialResolver: vi.fn(),
  resourceCacheForEngine: vi.fn(),
  getMaterialTexture: vi.fn(),
  ParticleService: vi.fn(),
}));
vi.mock("../context/play-context", () => {
  const engine = {};
  const play = { ensureSharedEngine: () => engine };
  return { useOptionalPlay: () => play };
});
vi.mock("../context/document-context", () => {
  const documents = {
    readAssetChunk: async () => new Uint8Array([137, 80, 78, 71]),
    assetRegistry: {
      list: () => [
        { header: { guid: "texture" }, path: "assets/spark.texture.babasset" },
      ],
    },
  };
  return { useDocuments: () => documents };
});

afterEach(() => {
  cleanup();
  createScene.mockClear();
});

describe("Particle preview recovery", () => {
  it("shows renderer failures and retries them instead of leaving a blank canvas", async () => {
    const library = systemPreviewLibrary(
      { ...createDefaultParticleSystemPayload(), emitterGuids: ["emitter"] },
      new Map([
        [
          "emitter",
          { ...createDefaultParticleEmitterPayload(), textureGuid: "texture" },
        ],
      ]),
    );
    render(
      <ParticlePreviewCanvas
        library={library}
        systemGuid="preview-sys"
        testId="particle-canvas"
      />,
    );
    expect(await screen.findByText("Preview Failed")).toBeTruthy();
    expect(screen.queryByText("Loading Preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(createScene).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Preview Failed")).toBeTruthy();
  });
});
