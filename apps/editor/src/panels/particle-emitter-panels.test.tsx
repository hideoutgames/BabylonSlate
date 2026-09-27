import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DocumentEditStack, SetAssetDocumentCommand } from "@babylonslate/edit";
import {
  createDefaultParticleEmitterPayload,
  normalizeParticleEmitterPayload,
  type ParticleEmitterPayload,
} from "@babylonslate/assets";
import { ParticleEmitterEditor, ParticleEmitterPreview } from "./particle-emitter-panels";

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

vi.mock("../context/play-context", () => ({ useOptionalPlay: () => null }));
const mocks = vi.hoisted(() => ({ setTextureUsage: vi.fn(async () => ({ previousUsage: "albedo" })) }));

vi.mock("../context/document-context", async () => {
  const { createDefaultMaterialDocument } = await import("@babylonslate/shader-graph");
  // SparksMat samples a 30x30 Albedo Texture, which WebGPU rejects once compressed.
  const sparks = createDefaultMaterialDocument("SparksMat", "particle");
  sparks.nodes.push({ id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-spark" } });
  sparks.edges = [
    { id: "e-sample-output", sourceNodeId: "sample", sourcePinId: "rgba", targetNodeId: "output", targetPinId: "color" },
  ];
  const spark = {
    path: "assets/Spark.babasset",
    header: { guid: "tex-spark", name: "Spark", type: "Texture", payload: { usage: "albedo", width: 30, height: 30 } },
  };
  const documents = {
    registryVersion: 0,
    setTextureUsage: mocks.setTextureUsage,
    textureUsageBlockedReason: () => null,
    collectPlayMaterialLibrary: async (_scene: unknown, _extra: unknown, guids: readonly string[]) => ({
      documents: new Map(guids.includes("mat-particle") ? [["mat-particle", sparks]] : []),
      functions: new Map(),
      textureGuids: [],
    }),
    assetRegistry: {
      textureEncodeMaxDimension: 2048,
      getByGuid: (guid: string) => (guid === spark.header.guid ? spark : undefined),
      list: () => [
        {
          header: { guid: "mat-surface", name: "Rock", type: "Material", payload: { domain: "surface" } },
          path: "assets/Rock.material.babasset",
        },
        {
          header: { guid: "mat-particle", name: "SparksMat", type: "Material", payload: { domain: "particle" } },
          path: "assets/SparksMat.material.babasset",
        },
      ],
    },
    openDocuments: [],
  };
  return { useDocuments: () => documents };
});

afterEach(() => {
  cleanup();
});

type Doc = Record<string, unknown>;

/** Details over a real undo stack; `endGesture` stands in for the editor's gesture boundaries. */
function renderWithHistory(initial: ParticleEmitterPayload) {
  const stack = new DocumentEditStack<Doc>({ maxEntries: 50, maxBytes: 1_000_000 });
  let current = initial as unknown as Doc;
  function History() {
    const [doc, setDoc] = useState(current);
    current = doc;
    return (
      <ParticleEmitterEditor
        payload={doc}
        onChange={(next, mergeKey) => {
          current = stack.apply(doc, new SetAssetDocumentCommand(doc, next, mergeKey)).doc;
          setDoc(current);
        }}
      />
    );
  }
  render(<History />);
  return {
    stack,
    read: () => normalizeParticleEmitterPayload(current),
    undo: () => {
      current = stack.undo(current)!.doc;
    },
  };
}

function type(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe("ParticleEmitterEditor", () => {
  it("records one undo entry per gesture on a field", () => {
    const history = renderWithHistory(createDefaultParticleEmitterPayload());
    type("property-lifetime-min", "0.5");
    type("property-lifetime-min", "0.6");
    history.stack.endGesture();
    type("property-lifetime-min", "0.7");
    expect(history.read().initialize.lifetime).toEqual({ mode: "range", min: 0.7, max: 1.2 });
    expect(history.stack.undoDepth).toBe(2);
    history.undo();
    expect(history.read().initialize.lifetime).toEqual({ mode: "range", min: 0.6, max: 1.2 });
    history.undo();
    expect(history.read().initialize.lifetime).toEqual({ mode: "range", min: 0.8, max: 1.2 });
  });

  it("switches a value mode in one step and keeps the look", () => {
    const history = renderWithHistory(createDefaultParticleEmitterPayload());
    fireEvent.click(screen.getByRole("button", { name: "Lifetime Value Mode, Random Range" }));
    fireEvent.click(screen.getByTestId("value-mode-lifetime-constant"));
    expect(history.read().initialize.lifetime).toEqual({ mode: "constant", value: 1 });
    expect((screen.getByTestId("property-lifetime") as HTMLInputElement).value).toBe("1");
    expect(screen.queryByTestId("property-lifetime-min")).toBeNull();
    expect(history.stack.undoDepth).toBe(1);
  });

  it("keeps burst entries while the Bursts module is off", () => {
    const initial = createDefaultParticleEmitterPayload();
    initial.spawn.bursts = {
      enabled: true,
      entries: [
        { time: 0, count: 12, cycles: 1, interval: 0.5 },
        { time: 1, count: 30, cycles: 2, interval: 0.25 },
      ],
    };
    const history = renderWithHistory(initial);
    const toggle = () => fireEvent.click(screen.getByRole("switch", { name: "Bursts Enabled" }));
    toggle();
    expect(history.read().spawn.bursts.enabled).toBe(false);
    expect(screen.queryByTestId("module-card-bursts-body")).toBeNull();
    toggle();
    expect(history.read().spawn.bursts).toEqual(initial.spawn.bursts);
    expect((screen.getByTestId("property-burst-1-count") as HTMLInputElement).value).toBe("30");
  });

  it("keeps the fields two shapes share when the shape changes", async () => {
    const initial = createDefaultParticleEmitterPayload();
    initial.shape = {
      kind: "sphere",
      radius: 2,
      radiusRange: 0.25,
      direction: { mode: "radial", randomizer: 0.5 },
    };
    const history = renderWithHistory(initial);
    fireEvent.click(screen.getByTestId("property-shape"));
    const cone = await screen.findByRole("option", { name: "Cone" });
    fireEvent.pointerDown(cone);
    fireEvent.click(cone);
    await waitFor(() => expect(history.read().shape.kind).toBe("cone"));
    expect(history.read().shape).toMatchObject({
      kind: "cone",
      radius: 2,
      radiusRange: 0.25,
      direction: { mode: "radial", randomizer: 0.5 },
    });
  });

  it("shows No Material on the collapsed Emitter card and picks a particle Material", async () => {
    const history = renderWithHistory(createDefaultParticleEmitterPayload());
    fireEvent.click(screen.getByTestId("module-card-emitter-toggle"));
    expect(screen.getByTestId("module-card-emitter-summary").textContent).toBe("No Material");
    fireEvent.click(screen.getByTestId("module-card-emitter-toggle"));
    fireEvent.click(screen.getByTestId("property-material"));
    await waitFor(() => expect(screen.getByTestId("search-item-mat-particle")).toBeTruthy());
    expect(screen.queryByTestId("search-item-mat-surface")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-mat-particle"));
    expect(history.read().render.materialGuid).toBe("mat-particle");
  });

  it("warns above a collapsed Emitter card when its Material samples a Texture WebGPU would reject", async () => {
    const initial = createDefaultParticleEmitterPayload();
    initial.render.materialGuid = "mat-particle";
    renderWithHistory(initial);
    fireEvent.click(screen.getByTestId("module-card-emitter-toggle"));
    expect(screen.queryByTestId("module-card-emitter-body")).toBeNull();
    const notice = await screen.findByTestId("particle-texture-usage-notice");
    expect(notice.textContent).toContain(
      'Texture "Spark" is 30×30; set its Usage to Particle so it loads on WebGPU.',
    );
    fireEvent.click(within(notice).getByRole("button", { name: "Set Usage To Particle" }));
    expect(mocks.setTextureUsage).toHaveBeenCalledWith("tex-spark", "particle");
    // The fix is confirmed in Details, where it was clicked.
    expect((await screen.findByTestId("texture-usage-notification-tex-spark")).textContent).toContain(
      'Texture "Spark" now uses Particle Usage.',
    );
  });

  it("opens a P17-shaped document with the new module defaults", () => {
    renderWithHistory({
      textureGuid: "tex-1",
      emitRate: 45,
      minSize: 0.1,
      maxSize: 0.5,
      blendMode: "standard",
    } as unknown as ParticleEmitterPayload);
    expect((screen.getByTestId("property-rate") as HTMLInputElement).value).toBe("20");
    expect(screen.getByTestId("property-blendMode").textContent).toContain("Additive");
    expect(screen.queryByTestId("property-texture")).toBeNull();
  });
});

describe("ParticleEmitterPreview", () => {
  it("offers Pick Material when the emitter has none", async () => {
    const onChange = vi.fn();
    render(
      <ParticleEmitterPreview
        payload={createDefaultParticleEmitterPayload() as unknown as Doc}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("No Material")).toBeTruthy();
    expect(screen.queryByTestId("particle-emitter-preview-canvas")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pick Material" }));
    await waitFor(() => expect(screen.getByTestId("search-item-mat-particle")).toBeTruthy());
    expect(screen.queryByTestId("search-item-mat-surface")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-mat-particle"));
    expect(
      normalizeParticleEmitterPayload(onChange.mock.calls.at(-1)![0]).render.materialGuid,
    ).toBe("mat-particle");
  });
});
