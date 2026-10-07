import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInspectorResult, RuntimeObjectIdentity } from "@babylonslate/bridge";
import { identitySerializedTransform } from "@babylonslate/core";
import { SimulationInspectionStore } from "./simulation-inspection-store";
import type { RuntimeInspectionAction } from "./runtime-inspector-client";

const actor: RuntimeObjectIdentity = { sceneInstanceId: "root", actorGuid: "actor", actorToken: 1 };
function result(payload: RuntimeInspectorResult["payload"], commandRevision = 0): RuntimeInspectorResult {
  return { sessionGeneration: 1, requestId: 1, success: true, tickIndex: 1, frameId: 1, commandRevision, structuralRevision: 1, payload };
}
const identities = () => result({ kind: "identities", rows: [{ identity: actor, name: "Actor", classId: "Actor", kind: "actor", parent: null }], unchanged: false });
const selection = (target = actor, value = "Before", revision = 0) => result({ kind: "selection", target, classId: "Actor", transform: identitySerializedTransform(), transformCapability: "live",
  properties: [{ key: "name", name: "Name", typeId: "string", capability: "live", value }] }, revision);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

describe("SimulationInspectionStore", () => {
  it("requests only with a visible consumer and never overlaps reads", async () => {
    vi.useFakeTimers();
    const pending = deferred<RuntimeInspectorResult>();
    const transport = vi.fn(() => pending.promise);
    const store = new SimulationInspectionStore();
    store.attach(transport);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).not.toHaveBeenCalled();
    const release = store.consume("identities");
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).toHaveBeenCalledTimes(1);
    release(); pending.resolve(identities());
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().rows).toHaveLength(0);
  });

  it("keeps destroyed selection identity and rejects late details after token reuse", async () => {
    vi.useFakeTimers();
    const pending = deferred<RuntimeInspectorResult>();
    const replacement = { ...actor, actorToken: 2 };
    const transport = vi.fn((action: RuntimeInspectionAction) => action.kind === "identities" ? Promise.resolve(identities()) : pending.promise);
    const store = new SimulationInspectionStore(); store.attach(transport); store.select(actor); store.consume("selection");
    await vi.advanceTimersByTimeAsync(0);
    store.select(replacement);
    pending.resolve(selection(actor));
    await Promise.resolve(); await Promise.resolve();
    expect(store.getSnapshot().selected).toEqual(replacement);
    expect(store.getSnapshot().selection).toBeNull();
  });

  it("does not let an older poll overwrite an acknowledged mutation", async () => {
    vi.useFakeTimers();
    const oldPoll = deferred<RuntimeInspectorResult>(); let polls = 0;
    const transport = vi.fn((action: RuntimeInspectionAction) => {
      if (action.kind === "identities") return Promise.resolve(identities());
      if (action.kind === "selection") return ++polls === 1 ? Promise.resolve(selection()) : oldPoll.promise;
      return Promise.resolve(result({ kind: "mutation", target: actor, sequence: 3, effectiveValue: "After" }, 2));
    });
    const store = new SimulationInspectionStore(); store.attach(transport); store.select(actor); store.consume("selection");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    await store.request({ kind: "setProperty", target: actor, property: "name", value: "After" }, { final: true });
    oldPoll.resolve(selection(actor, "Before", 1));
    await Promise.resolve(); await Promise.resolve();
    expect(store.getSnapshot().selection?.properties[0]?.value).toBe("After");
  });

  it("detaches session data and ignores stopped-session replies", async () => {
    vi.useFakeTimers(); const pending = deferred<RuntimeInspectorResult>();
    const store = new SimulationInspectionStore(); const detach = store.attach(() => pending.promise);
    store.consume("identities"); await vi.advanceTimersByTimeAsync(0); detach();
    pending.resolve(identities()); await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot()).toMatchObject({ connected: false, rows: [], selected: null });
  });
});
