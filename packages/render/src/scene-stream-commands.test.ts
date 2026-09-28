import { describe, expect, it } from "vitest";
import { decodeSceneStreamEvent } from "./scene-stream-commands";

describe("scene stream command decoding", () => {
  it.each(["sceneLoading", "activeScene"])("decodes %s as a lifecycle reset", (type) => {
    expect(decodeSceneStreamEvent({ type })).toEqual({ kind: "reset" });
  });

  it("ignores unrelated commands", () => {
    expect(decodeSceneStreamEvent({ type: "spawn", actorGuid: "stream", streamLoadId: 1 })).toBeNull();
  });

  it.each([0, 1.5, "1"])("rejects invalid stream load identity %s", (streamLoadId) => {
    expect(decodeSceneStreamEvent({ type: "sceneStreamLoading", actorGuid: "stream", streamLoadId })).toBeNull();
  });

  it("rejects realized events with malformed slots", () => {
    expect(decodeSceneStreamEvent({
      type: "sceneStreamRealized", actorGuid: "stream", streamLoadId: 2, slotIds: [1, -1],
    })).toBeNull();
  });

  it("decodes a complete realized actor batch", () => {
    expect(decodeSceneStreamEvent({
      type: "sceneStreamRealized", actorGuid: "stream", streamLoadId: 2, slotIds: [1, 3],
    })).toEqual({
      kind: "realized", identity: { actorGuid: "stream", streamLoadId: 2 }, slotIds: [1, 3],
    });
  });
});
