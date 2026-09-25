import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  normalizeParticleSystemPayload,
  type ParticleSystemPayload,
} from "@babylonslate/assets";
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

const loadAssetDocument = vi.hoisted(() => vi.fn());

vi.mock("../context/play-context", () => ({ useOptionalPlay: () => null }));
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
          header: { guid: "mat-1", name: "SparksMat", type: "Material" },
          path: "assets/SparksMat.material.babasset",
        },
      ],
    },
    openDocuments: [],
    loadAssetDocument,
  }),
}));

afterEach(() => {
  cleanup();
  loadAssetDocument.mockReset();
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
});

describe("ParticleSystemPreview", () => {
  const system = { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] };
  const emitter = createDefaultParticleEmitterPayload();
  const withMaterial = { ...emitter, render: { ...emitter.render, materialGuid: "mat-1" } };

  it("recovers a failed emitter document read without reopening the system", async () => {
    loadAssetDocument.mockRejectedValueOnce(new Error("Emitter read failed"));
    loadAssetDocument.mockResolvedValue(withMaterial);
    render(<ParticleSystemPreview payload={system as unknown as Record<string, unknown>} />);
    expect(await screen.findByText("Preview Failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("particle-system-preview-canvas")).toBeTruthy(),
    );
    expect(screen.queryByText("Preview Failed")).toBeNull();
    expect(loadAssetDocument).toHaveBeenCalledWith(
      "particle-emitter",
      "assets/Sparks.emitter.babasset",
    );
  });

  it("names a loaded emitter without a Material instead of drawing a blank canvas", async () => {
    loadAssetDocument.mockResolvedValue(emitter);
    render(<ParticleSystemPreview payload={system as unknown as Record<string, unknown>} />);
    expect(await screen.findByText("No Material")).toBeTruthy();
    expect(screen.queryByTestId("particle-system-preview-canvas")).toBeNull();
  });
});
