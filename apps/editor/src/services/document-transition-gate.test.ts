import { describe, expect, it, vi } from "vitest";
import { DocumentTransitionGate } from "./document-transition-gate";

describe("document transition ownership", () => {
  it("preserves synchronous navigation when no session owns a hold", () => {
    const gate = new DocumentTransitionGate();
    expect(gate.check({ kind: "close-document", documentId: "asset" })).toBe(true);
    const release = gate.register(() => true);
    expect(gate.check({ kind: "close-project" })).toBe(true);
    release();
    release();
    expect(gate.check({ kind: "replace-project" })).toBe(true);
  });
  it("waits for actual owner release and stops later handlers when retention refuses closure", async () => {
    const gate = new DocumentTransitionGate();
    let resolve!: (allowed: boolean) => void;
    gate.register(() => new Promise<boolean>(done => { resolve = done; }));
    const later = vi.fn(() => true);
    gate.register(later);
    const transition = gate.check({ kind: "close-project" });
    expect(later).not.toHaveBeenCalled();
    resolve(false);
    expect(await transition).toBe(false);
    expect(later).not.toHaveBeenCalled();
    const accepted = gate.check({ kind: "replace-document", documentId: "scene" });
    resolve(true);
    expect(await accepted).toBe(true);
    expect(later).toHaveBeenCalledWith({ kind: "replace-document", documentId: "scene" });
  });
});
