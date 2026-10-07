import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInspectorRequest, RuntimeInspectorResult, RuntimeObjectIdentity } from "@babylonslate/bridge";
import { identitySerializedTransform } from "@babylonslate/core";
import { RuntimeInspectorClient } from "./runtime-inspector-client";

const target: RuntimeObjectIdentity = { sceneInstanceId: "root:1", actorGuid: "actor", actorToken: 7 };
const edit = (value: number, identity = target) => ({ kind: "setProperty" as const, target: identity, property: "health", value });
function reply(request: RuntimeInspectorRequest): RuntimeInspectorResult {
  const action = request.action;
  return { sessionGeneration: request.sessionGeneration, requestId: request.requestId, success: true,
    tickIndex: 40, frameId: 80, commandRevision: 3, structuralRevision: 1,
    payload: action.kind === "identities" ? { kind: "identities", rows: [], unchanged: false }
      : action.kind === "resolvePick" ? { kind: "identity", row: { identity: target, classId: "Actor", name: "Actor", kind: "actor", parent: null, renderSlotId: action.slotId } }
      : action.kind === "selection" ? { kind: "selection", target: action.target, classId: "Actor", properties: [], transformCapability: "live",
        transform: identitySerializedTransform() }
      : action.kind === "value" ? { kind: "value", property: action.property, value: 5 }
      : { kind: "mutation", target: action.target, sequence: action.sequence, effectiveValue: action.kind === "setProperty" ? action.value : null },
  };
}
function fixture(options: { maxRequests?: number; maxBytes?: number; timeoutMs?: number } = {}) {
  const sent: RuntimeInspectorRequest[] = [];
  const client = new RuntimeInspectorClient({ sessionGeneration: 9, send: request => { sent.push(request); }, ...options });
  return { client, sent };
}

describe("runtime Inspector client", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("correlates out-of-order replies and rejects a recycled identity or wrong mutation sequence", async () => {
    const { client, sent } = fixture();
    const first = client.request(edit(10));
    const firstRejected = expect(first).rejects.toMatchObject({ code: "invalid" });
    const second = client.request(edit(20, { ...target, actorToken: 8 }));
    const stale = { ...reply(sent[0]!), sessionGeneration: 8 };
    client.receive(stale);
    expect(client.pendingCount).toBe(2);
    client.receive(reply(sent[1]!));
    expect((await second).payload).toMatchObject({ effectiveValue: 20 });
    const wrong = reply(sent[0]!);
    if (wrong.payload?.kind === "mutation") wrong.payload.target = { ...target, actorToken: 8 };
    client.receive(wrong);
    await firstRejected;
    const next = client.request(edit(30));
    const rejected = expect(next).rejects.toMatchObject({ code: "invalid" });
    const wrongSequence = reply(sent[2]!);
    if (wrongSequence.payload?.kind === "mutation") wrongSequence.payload.sequence++;
    client.receive(wrongSequence);
    await rejected;
    client.dispose();
  });

  it("coalesces continuous drafts while retaining a reliable final value and ordered discrete edits", async () => {
    const { client, sent } = fixture();
    const first = client.request(edit(1), { continuous: true });
    const oldDraft = client.request(edit(2), { continuous: true });
    const superseded = expect(oldDraft).rejects.toMatchObject({ code: "superseded" });
    const newest = client.request(edit(3), { continuous: true });
    await superseded;
    expect(sent).toHaveLength(1);
    const replacedByFinal = expect(newest).rejects.toMatchObject({ code: "superseded" });
    const final = client.request(edit(4), { continuous: true, final: true });
    await replacedByFinal;
    const discrete = client.request(edit(5));
    client.receive(reply(sent[0]!));
    await first;
    expect(sent).toHaveLength(2);
    expect(sent[1]!.action).toMatchObject({ value: 4 });
    client.receive(reply(sent[1]!));
    await final;
    expect(sent[2]!.action).toMatchObject({ value: 5 });
    client.receive(reply(sent[2]!));
    await discrete;
    expect(client.pendingCount).toBe(0);
    expect(client.pendingBytes).toBe(0);
    client.dispose();
  });

  it("owns a bounded immutable typed payload and preserves accepted requests when a new draft is oversized", async () => {
    const { client, sent } = fixture({ maxRequests: 2 });
    const action = edit(1);
    const first = client.request(action, { continuous: true });
    action.value = 99;
    expect(sent[0]!.action).toMatchObject({ value: 1 });
    const pending = client.request(edit(2), { continuous: true });
    await expect(client.request({ ...edit(3), value: "x".repeat(70_000) }, { continuous: true })).rejects.toMatchObject({ code: "budget" });
    await expect(client.request({ kind: "identities" })).rejects.toMatchObject({ code: "budget" });
    expect(client.pendingCount).toBe(2);
    client.receive(reply(sent[0]!));
    await first;
    expect(sent[1]!.action).toMatchObject({ value: 2 });
    client.receive(reply(sent[1]!));
    await pending;
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await expect(client.request({ ...edit(3), value: cyclic as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.request(edit(Number.NaN))).rejects.toMatchObject({ code: "invalid" });
    const getter = vi.fn(() => 3);
    await expect(client.request({ ...edit(4), value: Object.defineProperty({}, "x", { get: getter, enumerable: true }) })).rejects.toMatchObject({ code: "invalid" });
    expect(getter).not.toHaveBeenCalled();
    client.dispose();
  });

  it("dispatches monotonic wire IDs when a different lane overtakes a queued edit", async () => {
    const { client, sent } = fixture();
    const first = client.request(edit(1));
    const queued = client.request(edit(2));
    const other = client.request({ kind: "identities" });
    expect(sent.map(request => request.requestId)).toEqual([1, 2]);
    client.receive(reply(sent[1]!));
    await other;
    client.receive(reply(sent[0]!));
    await first;
    expect(sent[2]!.requestId).toBe(3);
    expect(sent[2]!.action).toMatchObject({ sequence: 2, value: 2 });
    client.receive(reply(sent[2]!));
    await queued;
    client.dispose();
  });

  it("bounds aggregate bytes independently of request count", async () => {
    const { client, sent } = fixture({ maxBytes: 900 });
    const first = client.request({ ...edit(1), value: "a".repeat(90) });
    const bytes = client.pendingBytes;
    expect(bytes).toBeGreaterThan(450);
    await expect(client.request({ ...edit(2, { ...target, actorToken: 8 }), value: "b".repeat(90) })).rejects.toMatchObject({ code: "budget" });
    expect(client.pendingBytes).toBe(bytes);
    client.receive(reply(sent[0]!));
    await first;
    expect(client.pendingBytes).toBe(0);
    client.dispose();
  });

  it("invalidates destroyed objects and stops without dispatching their queued edits", async () => {
    const { client, sent } = fixture();
    const requests = Promise.allSettled([client.request(edit(1)), client.request(edit(2)), client.request({ kind: "selection", target }),
      client.request({ kind: "resolvePick", actorGuid: target.actorGuid, slotId: 3 })]);
    expect(sent).toHaveLength(3);
    client.invalidateActor(target.actorGuid);
    expect((await requests).every(result => result.status === "rejected" && result.reason.code === "invalidated")).toBe(true);
    expect(sent).toHaveLength(3);
    client.receive(reply(sent[0]!));
    const reused = client.request(edit(3, { ...target, actorToken: 8 }));
    const stopped = expect(reused).rejects.toMatchObject({ code: "stopped" });
    client.dispose();
    await stopped;
    await expect(client.request({ kind: "identities" })).rejects.toMatchObject({ code: "stopped" });
    expect(client.pendingBytes).toBe(0);
  });

  it("serializes selection reads and cancels both in-flight and queued reads on scene replacement", async () => {
    const { client, sent } = fixture();
    const results = Promise.allSettled([client.request({ kind: "selection", target }), client.request({ kind: "selection", target, offset: 16 })]);
    expect(sent).toHaveLength(1);
    client.invalidateScene(target.sceneInstanceId);
    expect((await results).every(result => result.status === "rejected")).toBe(true);
    expect(sent).toHaveLength(1);
    client.dispose();
  });

  it("times out a lane, ignores late replies, and frees timers on transport failure", async () => {
    vi.useFakeTimers();
    const { client, sent } = fixture({ timeoutMs: 25 });
    const results = Promise.allSettled([client.request(edit(1)), client.request(edit(2))]);
    await vi.advanceTimersByTimeAsync(25);
    expect((await results).every(result => result.status === "rejected" && result.reason.code === "timeout")).toBe(true);
    expect(sent).toHaveLength(1);
    client.receive(reply(sent[0]!));
    client.dispose();
    const broken = new RuntimeInspectorClient({ sessionGeneration: 9, send: async () => { throw new Error("Worker terminated"); } });
    await expect(broken.request({ kind: "identities" })).rejects.toMatchObject({ code: "transport" });
    expect(broken.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    broken.dispose();
  });
});
