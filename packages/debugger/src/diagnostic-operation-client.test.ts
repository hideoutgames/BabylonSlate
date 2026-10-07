import { describe, expect, it } from "vitest";
import { createDiagnosticOperationClient, type RuntimeDiagnosticOperationRequest } from "./diagnostic-operation-client";

describe("diagnostic operation correlation", () => {
  it("rejects mismatched generation, request and capture identity before resolving", async () => {
    const sent: RuntimeDiagnosticOperationRequest[] = [];
    const client = createDiagnosticOperationClient({ sessionGeneration: 7, send: (request) => { sent.push(request); } });
    const request = client.request({ kind: "profile", action: "start", recordingId: "recording" });
    const reply = { sessionGeneration: 7, requestId: sent[0]!.requestId, recordingId: "recording", success: true };
    expect(client.receive({ ...reply, sessionGeneration: 6 })).toBe(false);
    expect(client.receive({ ...reply, requestId: 10 })).toBe(false);
    expect(client.receive({ ...reply, recordingId: "old" })).toBe(false);
    expect(client.receive(reply)).toBe(true);
    expect(await request).toEqual({ success: true });
    const pending = client.request({ kind: "frame", action: "start", recordingId: "next" });
    client.dispose();
    expect(await pending).toMatchObject({ success: false, reason: "Game session stopped." });
  });
});
