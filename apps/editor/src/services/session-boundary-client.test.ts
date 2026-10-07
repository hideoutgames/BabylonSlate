import { describe, expect, it, vi } from "vitest";
import type { SessionBoundaryResult } from "@babylonslate/bridge";
import { createSessionBoundaryClient } from "./session-boundary-client";

function response(requestId: number, sessionGeneration = 4): SessionBoundaryResult {
  return { requestId, sessionGeneration, success: true, paused: true, pauseReasons: ["user"],
    tickIndex: 8, sceneAssetGuid: "scene", sceneLoadId: 1, commandRevision: 12 };
}

describe("game boundary correlation", () => {
  it("resolves out-of-order acknowledgments by request and generation", async () => {
    const client = createSessionBoundaryClient(4, () => {});
    const first = client.request({ kind: "pause", reason: "user", paused: true });
    const second = client.request({ kind: "resetInput" });
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    client.receive(response(1, 3));
    client.receive(response(2));
    expect((await second).requestId).toBe(2);
    expect(firstSettled).toBe(false);
    client.receive(response(1));
    expect((await first).tickIndex).toBe(8);
    client.dispose();
  });

  it("bounds outstanding controls and rejects all pending controls on Stop", async () => {
    const client = createSessionBoundaryClient(4, () => {});
    const results = Promise.allSettled(Array.from({ length: 64 }, () => client.request({ kind: "resetInput" })));
    await expect(client.request({ kind: "resetInput" })).rejects.toThrow("Too many");
    client.dispose();
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    await expect(client.request({ kind: "resetInput" })).rejects.toThrow("stopped");
  });

  it("times out an unresponsive runtime without accepting a late acknowledgment", async () => {
    vi.useFakeTimers();
    try {
      const client = createSessionBoundaryClient(4, () => {}, 25);
      const result = expect(client.request({ kind: "resetInput" })).rejects.toThrow("did not acknowledge");
      await vi.advanceTimersByTimeAsync(25);
      await result;
      client.receive(response(1));
      client.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
