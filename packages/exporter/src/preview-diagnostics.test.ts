import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewDiagnosticClient, createPreviewDiagnosticServer, type PreviewProfileTransfer } from "./preview-diagnostics";

const origin = "https://editor.example";
const host = {}, player = {};
function linked(execute = async () => ({ success: true, result: "packaged frame" })) {
  const profiles: PreviewProfileTransfer[] = [];
  const errors: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const server = createPreviewDiagnosticServer({ source: () => host, origin: () => origin,
    send: (message, transfer) => { sent.push(message as Record<string, unknown>); client.receive({ source: player, origin, data: structuredClone(message, { transfer }) }); } },
    { execute, close: async () => {} });
  const client = createPreviewDiagnosticClient({ source: () => player, origin: () => origin,
    send: (message, transfer) => server.receive({ source: host, origin, data: structuredClone(message, { transfer }) }) },
    { onProfile: (profile) => profiles.push(profile), onError: (error) => errors.push(error) });
  return { client, server, profiles, errors, sent };
}

describe("Preview diagnostics transport", () => {
  afterEach(() => vi.useRealTimers());

  it("uses correlated requests and bounded transfers without detaching the retained player result", async () => {
    const pair = linked();
    expect(await pair.client.request("frame")).toEqual({ success: true, result: "packaged frame", reason: undefined });
    const frames = new Float64Array([1, 2, 3]);
    const memory = new Float64Array([0, 1024, 2048]);
    const longTasks = new Float64Array([5, 60]);
    expect(await pair.server.publishProfile({ metadata: { byteBudget: 4096 }, frames: [frames], ticks: [], gpu: [], memory: [memory], longTasks: [longTasks] }))
      .toEqual({ success: true });
    expect(frames.byteLength).toBe(24);
    expect(pair.profiles[0]?.frames[0]).toEqual(frames);
    expect(pair.profiles[0]?.memory[0]).toEqual(memory);
    expect(pair.profiles[0]?.longTasks[0]).toEqual(longTasks);
    expect(pair.profiles[0]?.frames[0]?.buffer).not.toBe(frames.buffer);
    pair.client.dispose(); pair.server.dispose();
  });

  it("reports a failed profile transfer to the publisher as well as the editor", async () => {
    const pair = linked();
    await pair.client.connect();
    const published = await pair.server.publishProfile({ metadata: { byteBudget: 1 << 20 }, frames: [new Float64Array(8192)], ticks: [], gpu: [], memory: [], longTasks: [] });
    expect(published).toMatchObject({ success: false, reason: expect.stringContaining("transport budget") });
    expect(pair.errors).toEqual([published.reason]);
    expect(pair.profiles).toEqual([]);
    pair.client.dispose(); pair.server.dispose();
  });

  it("rejects foreign source, origin and session and discards an incomplete capture", async () => {
    const pair = linked();
    await pair.client.connect();
    const ready = pair.sent[0]!;
    const start = { ...ready, action: "profile-start", profileId: 1, metadata: { byteBudget: 4096 } };
    pair.client.receive({ source: {}, origin, data: start });
    pair.client.receive({ source: player, origin: "https://other.example", data: start });
    pair.client.receive({ source: player, origin, data: { ...start, session: "old" } });
    pair.client.receive({ source: player, origin, data: { ...ready, action: "profile-end", profileId: 1, sequence: 0 } });
    expect(pair.profiles).toHaveLength(0);
    pair.client.receive({ source: player, origin, data: start });
    pair.client.receive({ source: player, origin, data: { ...ready, action: "profile-chunk", profileId: 1,
      sequence: 2, stream: "frames", rows: new Float64Array([1]) } });
    expect(pair.errors).toEqual(["Preview profile transfer was incomplete or exceeded its data budget."]);
    pair.client.dispose(); pair.server.dispose();
  });

  it("fails a profile transfer only after it goes idle and ignores an earlier profile's error", async () => {
    const pair = linked();
    await pair.client.connect();
    vi.useFakeTimers();
    const ready = pair.sent[0]!;
    const deliver = (message: Record<string, unknown>) => pair.client.receive({ source: player, origin, data: { ...ready, ...message } });
    deliver({ action: "profile-start", profileId: 2, metadata: { byteBudget: 4096 } });
    for (let sequence = 0; sequence < 3; sequence++) {
      await vi.advanceTimersByTimeAsync(6_000);
      deliver({ action: "profile-chunk", profileId: 2, sequence, stream: "frames", rows: new Float64Array([sequence]) });
    }
    deliver({ action: "profile-error", profileId: 1, reason: "Earlier profile failed." });
    deliver({ action: "profile-end", profileId: 2, sequence: 3 });
    expect(pair.errors).toEqual([]);
    expect(pair.profiles[0]?.frames).toHaveLength(3);
    deliver({ action: "profile-start", profileId: 3, metadata: { byteBudget: 4096 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pair.errors).toEqual(["Preview profile transfer timed out."]);
    pair.client.dispose(); pair.server.dispose();
  });

  it("bounds handshake time and clears pending requests when the iframe closes", async () => {
    vi.useFakeTimers();
    const client = createPreviewDiagnosticClient({ source: () => player, origin: () => origin, send: () => {} }, { onProfile: () => {} });
    const request = client.request("profile-start");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await request).toMatchObject({ success: false, reason: expect.stringContaining("did not respond") });
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
