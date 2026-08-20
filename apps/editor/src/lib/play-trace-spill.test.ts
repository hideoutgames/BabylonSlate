import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import type { TracePayload } from "@babylonslate/debugger";
import { readTraceDocument } from "@babylonslate/assets";
import {
  finishPlaySessionWithTrace,
  recordedTraceFileName,
  spillRecordedTraceDocument,
} from "./play-trace-spill";
import type { PlaySessionResult } from "../services/play-session";

const payload: TracePayload = {
  seed: 11,
  dt: 1 / 60,
  frames: [
    {
      tickIndex: 1,
      scriptMs: 1,
      physicsMs: 0.2,
      logs: [],
      prints: [],
      snapshotText: "tick=1",
    },
  ],
};

function baseResult(
  lastTrace: PlaySessionResult["lastTrace"],
): PlaySessionResult {
  return {
    diagnostics: [],
    droppedDiagnostics: 0,
    textureCountBefore: 0,
    textureCountAfter: 0,
    textureLeak: false,
    runtimeMode: "in-process",
    lastTrace,
  };
}

describe("play trace spill", () => {
  it("names a derived session file from the stop timestamp", () => {
    expect(recordedTraceFileName(1_700_000_000_000)).toBe("session-1700000000000");
  });

  it("writes a .babtrace under derived traces and returns a Trace document ref", async () => {
    const derived = new MemoryStorageAdapter("documents");
    await derived.openDocumentsProject("derived-traces");
    const spilled = await spillRecordedTraceDocument({
      derivedStorage: derived,
      projectGuid: "proj-1",
      payload,
      fileName: "session-1",
      documentGuid: "trace-guid",
    });
    expect(spilled.path).toBe("derived/proj-1/traces/session-1.babtrace");
    expect(spilled.ref).toEqual({
      kind: "trace",
      path: spilled.path,
      label: "Session 1 Trace",
    });
    const loaded = await readTraceDocument(derived, spilled.path);
    expect(loaded?.payload.seed).toBe(11);
    expect(loaded?.guid).toBe("trace-guid");
  });

  it("runs snapshot stop before session stop so lastTrace is captured", async () => {
    const calls: string[] = [];
    const result = await finishPlaySessionWithTrace({
      executeConsoleCommand: async (line) => {
        calls.push(line);
      },
      stop: () => {
        calls.push("stop");
        return baseResult(payload);
      },
    });
    expect(calls).toEqual(["snapshot stop", "stop"]);
    expect(result.lastTrace?.seed).toBe(11);
  });
});
