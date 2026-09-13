import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { readActorSlot, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import { createSceneSnapshotDelivery } from "./scene-snapshot-delivery";

describe("Scene batch snapshot delivery", () => {
  it("holds the batch until a resized transport accepts the complete authored pose", async () => {
    const events: Array<string | number> = [];
    let capacityAcknowledged = false;
    const snapshot = new Float32Array(snapshotFloatCount(8));
    const delivery = createSceneSnapshotDelivery({
      publishSnapshot: () => {
        if (!capacityAcknowledged || !runtime.copySnapshot(snapshot)) return false;
        events.push(readActorSlot(snapshot, 0).position.x);
        return true;
      },
      send: (command) => events.push(command.type),
    });
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, cooperativeSceneLoading: true,
      maxActors: 1, playSceneGuid: "scene", deferSceneModelsReady: true,
      playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", {
        transform: { position: [17, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }), createActor("other", "Other")] },
      onCommand: (command) => { if (!delivery.receive(command)) events.push(command.type); },
    });
    try {
      await runtime.realizePlayWorld();
      expect(events).toContain("snapshotLayout");
      expect(events).not.toContain("sceneRealized");
      capacityAcknowledged = true;
      delivery.flush();
      expect(events.slice(-2)).toEqual([17, "sceneRealized"]);
      delivery.flush();
      expect(events.filter((entry) => entry === "sceneRealized")).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it.each(["replacement", "Stop"] as const)("discards an undelivered marker on %s", (action) => {
    let available = false;
    const sent: CommandMessage[] = [];
    const delivery = createSceneSnapshotDelivery({ publishSnapshot: () => available, send: (command) => sent.push(command) });
    delivery.receive({ type: "sceneRealized", sceneAssetGuid: "same", sceneLoadId: 1 });
    if (action === "Stop") delivery.reset();
    else delivery.receive({ type: "activeScene", sceneAssetGuid: "same", sceneLoadId: 2 });
    available = true;
    delivery.flush();
    expect(sent).toEqual([]);
    delivery.receive({ type: "sceneRealized", sceneAssetGuid: "same", sceneLoadId: 2 });
    expect(sent).toEqual([{ type: "sceneRealized", sceneAssetGuid: "same", sceneLoadId: 2 }]);
  });
});
