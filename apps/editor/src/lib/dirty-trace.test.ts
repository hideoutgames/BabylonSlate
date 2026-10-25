import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginSaveAllProgress,
  clearDocumentDirtyTrace,
  documentDirtyTrace,
  recordDocumentDirty,
  recordSaveAllTrace,
  saveAllProgress,
  saveAllTrace,
} from "./dirty-trace";

afterEach(() => {
  clearDocumentDirtyTrace();
});

describe("documentDirtyTrace", () => {
  it("records the documents that were marked dirty", () => {
    recordDocumentDirty("scene", "scene:assets/main.scene.hasset");
    recordDocumentDirty("material", "material:assets/Rock.material.hasset");
    const trace = documentDirtyTrace();
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({
      kind: "scene",
      id: "scene:assets/main.scene.hasset",
    });
    expect(trace[0]?.via).toMatch(/recordDocumentDirty|dirty-trace\.test/);
    expect(trace[1]).toMatchObject({
      kind: "material",
      id: "material:assets/Rock.material.hasset",
    });
  });

  it("records the last Save All outcome", () => {
    recordSaveAllTrace({
      ok: true,
      reason: "saved",
      dirtyBefore: 1,
      dirtyAfter: 0,
    });
    expect(saveAllTrace()).toEqual({
      ok: true,
      reason: "saved",
      dirtyBefore: 1,
      dirtyAfter: 0,
    });
  });

  it("distinguishes a pending save from its last outcome without stale invocations ending the current save", () => {
    recordSaveAllTrace({ ok: true, reason: "saved", dirtyBefore: 1, dirtyAfter: 0 });
    const old = beginSaveAllProgress();
    old.phase("audio-reverb");
    expect(saveAllProgress()).toMatchObject({ phase: "audio-reverb", pending: true });
    expect(saveAllTrace()).toMatchObject({ ok: true, reason: "saved" });
    const current = beginSaveAllProgress();
    current.phase("documents");
    old.phase("callbacks");
    old.finish();
    expect(saveAllProgress()).toMatchObject({ phase: "documents", pending: true });
    current.finish();
    expect(saveAllProgress()).toMatchObject({ phase: "documents", pending: false });
    expect(saveAllProgress()!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("names how long each phase of a save took, the current one included, until it finishes", () => {
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValue(1_000);
      const save = beginSaveAllProgress();
      now.mockReturnValue(1_010);
      save.phase("documents");
      now.mockReturnValue(3_510);
      save.phase("journal");
      now.mockReturnValue(4_210);
      expect(saveAllProgress()).toMatchObject({
        phase: "journal",
        pending: true,
        elapsedMs: 3_210,
        phases: [
          { phase: "started", ms: 10 },
          { phase: "documents", ms: 2_500 },
          { phase: "journal", ms: 700 },
        ],
      });
      now.mockReturnValue(4_310);
      save.finish();
      now.mockReturnValue(9_000);
      expect(saveAllProgress()!.phases.at(-1)).toEqual({ phase: "journal", ms: 800 });
    } finally {
      now.mockRestore();
    }
  });
});
