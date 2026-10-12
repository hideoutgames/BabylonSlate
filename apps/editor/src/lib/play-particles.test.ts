import { describe, expect, it, vi } from "vitest";
import {
  PREVIEW_SYSTEM_GUID,
  emitterPreviewLibrary,
  loadEmittersForPreview,
  systemPreviewLibrary,
} from "./play-particles";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
  type ParticleEmitterPayload,
  type ParticleLibraryEmitter,
} from "@babylonslate/assets";
import { createDefaultParticleGraphDocument } from "@babylonslate/particle-graph";

const basic = (payload: ParticleEmitterPayload): ParticleLibraryEmitter => ({
  kind: "basic",
  payload,
});

const withMaterial = (materialGuid: string): ParticleEmitterPayload => {
  const payload = createDefaultParticleEmitterPayload();
  return { ...payload, render: { ...payload.render, materialGuid } };
};

const graphWithMaterial = (materialGuid: string) => ({
  ...createDefaultParticleGraphDocument("Embers"),
  materialGuid,
});

function basicPayload(entry: ParticleLibraryEmitter | undefined): ParticleEmitterPayload {
  if (entry?.kind !== "basic") throw new Error(`Expected a Basic emitter, got ${entry?.kind}`);
  return entry.payload;
}

function graphDocument(entry: ParticleLibraryEmitter | undefined) {
  if (entry?.kind !== "graph") throw new Error(`Expected a Particle Graph, got ${entry?.kind}`);
  return entry.document;
}

describe("preview libraries", () => {
  it("wraps a single Emitter as a Preview Particle System", () => {
    const library = emitterPreviewLibrary(basic(withMaterial("mat-1")));
    const slots = library.systems.get(PREVIEW_SYSTEM_GUID)?.emitterGuids ?? [];
    expect(slots).toHaveLength(1);
    expect(basicPayload(library.emitters.get(slots[0]!)).render.materialGuid).toBe("mat-1");
  });

  it("collects only the Emitters referenced by a System", () => {
    const library = systemPreviewLibrary(
      { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
      new Map([
        ["em-1", basic(withMaterial("mat-1"))],
        ["em-2", basic(createDefaultParticleEmitterPayload())],
      ]),
    );
    expect([...library.emitters.keys()]).toEqual(["em-1"]);
  });
});

describe("loadEmittersForPreview", () => {
  const assets = [
    {
      header: { guid: "em-1", type: "ParticleEmitter", payload: {} },
      path: "assets/Sparks.emitter.babasset",
    },
    {
      header: { guid: "pg-1", type: "ParticleGraph", payload: {} },
      path: "assets/Embers.particlegraph.babasset",
    },
  ];
  const system = { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] };

  it("loads closed Emitter document chunks instead of empty registry headers", async () => {
    const loadDocument = vi.fn(async () => ({
      emitter: { capacity: 64 },
      render: { materialGuid: "mat-1" },
    }));
    const emitters = await loadEmittersForPreview({
      system,
      assets,
      openPayloads: new Map(),
      loadDocument,
    });
    expect(loadDocument).toHaveBeenCalledWith(
      "particle-emitter",
      "assets/Sparks.emitter.babasset",
    );
    expect(basicPayload(emitters.get("em-1")).render.materialGuid).toBe("mat-1");
    expect(basicPayload(emitters.get("em-1")).emitter.capacity).toBe(64);
  });

  it("prefers an open Emitter tab over a disk load", async () => {
    const loadDocument = vi.fn(async () => ({ render: { materialGuid: "from-disk" } }));
    const emitters = await loadEmittersForPreview({
      system,
      assets,
      openPayloads: new Map([["em-1", { render: { materialGuid: "from-tab" } }]]),
      loadDocument,
    });
    expect(loadDocument).not.toHaveBeenCalled();
    expect(basicPayload(emitters.get("em-1")).render.materialGuid).toBe("from-tab");
  });

  it("loads a closed Particle Graph slot through its own document kind", async () => {
    const loadDocument = vi.fn(async () => graphWithMaterial("mat-2"));
    const emitters = await loadEmittersForPreview({
      system: { ...system, emitterGuids: ["pg-1"] },
      assets,
      openPayloads: new Map(),
      loadDocument,
    });
    expect(loadDocument).toHaveBeenCalledWith(
      "particle-graph",
      "assets/Embers.particlegraph.babasset",
    );
    expect(graphDocument(emitters.get("pg-1")).materialGuid).toBe("mat-2");
  });
});
