import { describe, expect, it, vi } from "vitest";
import type { CommandMessage, SimulationCaptureRequest, SimulationQuiesceRequest } from "@babylonslate/bridge";
import { createDefaultScene } from "@babylonslate/core";
import { simulationCaptureChunks } from "../../../../packages/runtime/src/simulation-capture-transport";
import { SimulationCaptureClient } from "./simulation-capture-client";

const identity = { generation: 5, sceneAssetGuid: "scene", sceneInstanceId: "instance", sceneLoadId: 1, tickIndex: 80, commandRevision: 24 };
function fixture(timeoutMs?: number) {
  const quiesces: SimulationQuiesceRequest[] = [], captures: SimulationCaptureRequest[] = [];
  const client = new SimulationCaptureClient({ generation: 5, timeoutMs,
    quiesce: request => { quiesces.push(request); }, capture: request => { captures.push(request); } });
  return { client, quiesces, captures };
}
async function freeze(client: SimulationCaptureClient, requestId = 1) {
  const result = client.quiesce();
  client.receive({ type: "simulationQuiesced", sessionGeneration: 5, requestId, success: true, paused: true,
    pauseReasons: ["loading"], tickIndex: 80, sceneAssetGuid: "scene", sceneLoadId: 1, commandRevision: 24 });
  return result;
}
const chunk = (sequence: number, bytes: Uint8Array, requestId = 2): Extract<CommandMessage, { type: "simulationCaptureChunk" }> =>
  ({ type: "simulationCaptureChunk", sessionGeneration: 5, requestId, sequence, bytes });

describe("final Simulation capture client", () => {
  it("round-trips actual bounded UTF-8 capture chunks only after a complete matching final summary", async () => {
    const { client, quiesces, captures } = fixture();
    await freeze(client);
    const scene = { ...createDefaultScene(), name: "x".repeat(2047) + "🐿" + " café" };
    const bytes = new TextEncoder().encode(JSON.stringify(scene));
    const result = client.capture(24);
    let settled = false;
    void result.then(() => { settled = true; });
    const parts = [...simulationCaptureChunks(scene)];
    parts.forEach((part, index) => client.receive(chunk(index, part)));
    expect(settled).toBe(false);
    client.receive({ type: "simulationCaptureResult", sessionGeneration: 4, requestId: 2,
      result: { ok: true, identity, byteSize: bytes.byteLength, chunkCount: parts.length } });
    expect(settled).toBe(false);
    client.receive({ type: "simulationCaptureResult", sessionGeneration: 5, requestId: 2,
      result: { ok: true, identity, byteSize: bytes.byteLength, chunkCount: parts.length } });
    expect(await result).toEqual({ ok: true, identity, byteSize: bytes.byteLength, scene });
    expect(quiesces[0]!.requestId).toBe(1);
    expect(captures[0]).toMatchObject({ requestId: 2, renderRevision: 24, maxBytes: 16 * 1024 * 1024 });
    client.dispose();
  });

  it("requires a real render boundary and accepts an in-process candidate without serializing it again", async () => {
    const { client, captures } = fixture();
    await expect(client.capture(24)).rejects.toThrow("acknowledged");
    await freeze(client);
    await expect(client.capture(25)).rejects.toThrow("acknowledged");
    const scene = createDefaultScene();
    const result = client.capture(24, 1024 * 1024);
    client.receiveComplete(captures[0]!, { ok: true, identity, scene, byteSize: 512 });
    const complete = await result;
    expect(complete.ok && complete.scene).toBe(scene);
    client.dispose();
  });

  it.each(["missing", "oversized", "count", "utf8", "changed"] as const)("refuses a %s transfer without returning a partial scene", async condition => {
    const { client } = fixture();
    await freeze(client);
    const result = expect(client.capture(24, 128)).rejects.toThrow();
    if (condition === "missing") client.receive(chunk(1, new Uint8Array([123])));
    else if (condition === "oversized") client.receive(chunk(0, new Uint8Array(129)));
    else if (condition === "utf8") client.receive(chunk(0, new Uint8Array([255])));
    else {
      client.receive(chunk(0, new TextEncoder().encode('{"actors":[]}')));
      client.receive({ type: "simulationCaptureResult", sessionGeneration: 5, requestId: 2,
        result: { ok: true, identity: condition === "changed" ? { ...identity, commandRevision: 25 } : identity,
          byteSize: 13, chunkCount: condition === "count" ? 2 : 1 } });
    }
    await result;
    client.dispose();
  });

  it("preserves exact runtime failure reasons even when the runtime reports a changed final boundary", async () => {
    const { client } = fixture();
    await freeze(client);
    const result = client.capture(24);
    const failure = { ok: false as const, code: "ownership" as const, path: "stream:layer", reason: "Independent SceneLayer instance cannot be retained.",
      identity: { ...identity, commandRevision: 25 } };
    client.receive({ type: "simulationCaptureResult", sessionGeneration: 5, requestId: 2, result: failure });
    expect(await result).toEqual(failure);
    await freeze(client, 3);
    client.dispose();
  });

  it("bounds fragment count, rejects concurrent capture and releases partial transfer state on Stop or timeout", async () => {
    vi.useFakeTimers();
    try {
      const { client } = fixture(20);
      await freeze(client);
      const capture = expect(client.capture(24, 128)).rejects.toThrow("chunks");
      await expect(client.capture(24)).rejects.toThrow("already pending");
      client.receive(chunk(0, new Uint8Array([123])));
      client.receive(chunk(1, new Uint8Array([34])));
      client.receive(chunk(2, new Uint8Array([34])));
      await capture;
      const pending = expect(client.quiesce()).rejects.toThrow("did not complete");
      await vi.advanceTimersByTimeAsync(20);
      await pending;
      const stopped = expect(client.quiesce()).rejects.toThrow("stopped");
      client.dispose();
      await stopped;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
