import { describe, expect, it } from "vitest";
import {
  decodeTraceDocument,
  encodeTraceDocument,
  isTracePath,
  TRACE_ASSET_TYPE,
} from "./trace";
import { readAssetDocumentHeader } from "./asset-document";

describe("trace documents", () => {
  it("round-trips a TracePayload through the .babasset container", async () => {
    const payload = {
      seed: 9,
      dt: 1 / 60,
      frames: [
        {
          tickIndex: 1,
          scriptMs: 1.5,
          physicsMs: 0.4,
          logs: [{ severity: "log", category: "game", message: "tick" }],
          prints: [],
          snapshotText: "tick=1",
        },
      ],
    };
    const bytes = await encodeTraceDocument({
      name: "session",
      guid: "trace-1",
      payload,
    });
    expect(readAssetDocumentHeader(bytes).type).toBe(TRACE_ASSET_TYPE);
    const decoded = await decodeTraceDocument(bytes);
    expect(decoded.payload).toEqual(payload);
    expect(isTracePath("derived/session.babtrace")).toBe(true);
    expect(isTracePath("assets/main.scene.babasset")).toBe(false);
  });
});
