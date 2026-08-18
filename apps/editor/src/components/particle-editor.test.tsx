import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
} from "@babylonslate/assets";
import {
  ParticleEmitterEditor,
  ParticleEmitterPreview,
  ParticleSystemEditor,
} from "./particle-editor";

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "Spark", type: "Texture" },
          path: "assets/Spark.texture.babasset",
        },
        {
          header: {
            guid: "mat-surface",
            name: "Rock",
            type: "Material",
            payload: { domain: "surface" },
          },
          path: "assets/Rock.material.babasset",
        },
        {
          header: {
            guid: "mat-particle",
            name: "SparksMat",
            type: "Material",
            payload: { domain: "particle" },
          },
          path: "assets/Sparks.material.babasset",
        },
        {
          header: { guid: "em-1", name: "Sparks", type: "ParticleEmitter" },
          path: "assets/Sparks.emitter.babasset",
        },
      ],
    },
    openDocuments: [],
  }),
}));

afterEach(() => {
  cleanup();
});

describe("ParticleEmitterEditor", () => {
  it("lets the author pick a Texture and a particle-domain Material", async () => {
    const payload = createDefaultParticleEmitterPayload();
    const onChange = vi.fn();
    render(
      <ParticleEmitterEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("particle-emitter-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-texture"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-tex-1")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ textureGuid: "tex-1" }),
    );

    fireEvent.click(screen.getByTestId("property-material"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-mat-particle")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-mat-surface")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-mat-particle"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ materialGuid: "mat-particle" }),
    );
  });

  it("shows No Texture in preview until a Texture guid is set", () => {
    render(
      <ParticleEmitterPreview
        payload={
          createDefaultParticleEmitterPayload() as unknown as Record<
            string,
            unknown
          >
        }
      />,
    );
    expect(screen.getByTestId("particle-emitter-preview")).toBeTruthy();
    expect(screen.getByText("No Texture")).toBeTruthy();
  });

  it("shows a live preview canvas once a Texture guid is set", () => {
    render(
      <ParticleEmitterPreview
        payload={
          {
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
          } as unknown as Record<string, unknown>
        }
      />,
    );
    expect(screen.getByTestId("particle-emitter-preview-canvas")).toBeTruthy();
  });
});

describe("ParticleSystemEditor", () => {
  it("lets the author pick Particle Emitter slots", async () => {
    const payload = createDefaultParticleSystemPayload();
    const onChange = vi.fn();
    render(
      <ParticleSystemEditor
        payload={payload as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("particle-system-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-emitter-0"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-em-1")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-item-em-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ emitterGuids: ["em-1"] }),
    );
  });
});
