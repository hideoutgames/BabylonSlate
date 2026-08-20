import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  decodeTraceDocument,
  encodeTraceDocument,
  isTracePath,
  readTraceDocument,
  TRACE_ASSET_TYPE,
  TRACE_FILE_EXTENSION,
  tracePath,
  tracesDir,
  writeTraceDocument,
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

  it("writes and reads a derived-data .babtrace", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("traces-root");
    const payload = {
      seed: 3,
      dt: 1 / 60,
      frames: [
        {
          tickIndex: 1,
          scriptMs: 2,
          physicsMs: 1,
          logs: [],
          prints: [],
          snapshotText: "tick=1",
        },
      ],
    };
    expect(tracesDir("proj-1")).toBe("derived/proj-1/traces");
    expect(tracePath("proj-1", "session-1")).toBe(
      `derived/proj-1/traces/session-1${TRACE_FILE_EXTENSION}`,
    );
    const path = await writeTraceDocument(storage, "proj-1", "session-1", {
      name: "session-1",
      guid: "trace-guid",
      payload,
    });
    expect(path).toBe(tracePath("proj-1", "session-1"));
    expect(await storage.exists(path)).toBe(true);
    const loaded = await readTraceDocument(storage, path);
    expect(loaded).not.toBeNull();
    expect(loaded?.guid).toBe("trace-guid");
    expect(loaded?.payload).toEqual(payload);
    await expect(readTraceDocument(storage, "missing.babtrace")).resolves.toBeNull();
  });
});
