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
    await pair.server.publishProfile({ metadata: { byteBudget: 4096 }, frames: [frames], ticks: [] });
    expect(frames.byteLength).toBe(24);
    expect(pair.profiles[0]?.frames[0]).toEqual(frames);
    expect(pair.profiles[0]?.frames[0]?.buffer).not.toBe(frames.buffer);
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
