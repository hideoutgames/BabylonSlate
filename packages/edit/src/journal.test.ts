import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import { MoveNodeCommand, SetGraphFunctionGraphsCommand } from "./commands/graph";
import {
  AddActorCommand,
  AddComponentCommand,
  RemoveActorCommand,
  RemoveComponentCommand,
  RenameActorCommand,
  ReorderActorCommand,
  ReorderComponentCommand,
  ReparentActorCommand,
  ReparentComponentCommand,
  SetActorFlagsCommand,
  SetActorTransformCommand,
  SetComponentPropertyCommand,
  SetSceneNameCommand,
  SetSceneSettingCommand,
  SetViewportModeCommand,
} from "./commands/scene";
import { SetAssetDocumentCommand } from "./commands/asset-document";
import {
  commandToJournalPayload,
  parseJournalLine,
  reviveCommand,
  serializeJournalLine,
  type JournalLine,
} from "./journal";

describe("journal", () => {
  it("serializes and parses journal lines", () => {
    const line: JournalLine = {
      v: 1,
      docId: "graph:assets/main.graph.babasset",
      at: "2026-08-11T17:00:00.000Z",
      command: {
        type: "graph.moveNode",
        nodeId: "log-1",
        from: { x: 0, y: 0 },
        to: { x: 10, y: 20 },
      },
    };

    const serialized = serializeJournalLine(line);
    expect(parseJournalLine(serialized)).toEqual(line);
  });

  it("rejects invalid journal lines", () => {
    expect(() => parseJournalLine('{"v":2}')).toThrow("Invalid journal line");
  });

  it("revives graph commands from journal payloads", () => {
    const payload = commandToJournalPayload(
      new MoveNodeCommand("node-1", { x: 0, y: 0 }, { x: 5, y: 5 }),
    );
    const revived = reviveCommand(payload);

    expect(revived).toBeInstanceOf(MoveNodeCommand);
    const graph = {
      nodes: [
        {
          id: "node-1",
          type: "logMessage",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const next = revived!.apply(graph) as typeof graph;
    expect(next.nodes[0]?.position).toEqual({ x: 5, y: 5 });
  });

  it("round-trips SetGraphFunctionGraphsCommand through the journal", () => {
    const functionGraphs = {
      "fn-1": {
        nodes: [
          {
            id: "fn-1-input",
            type: "flow.function.input",
            position: { x: 80, y: 120 },
            data: { title: "Input" },
          },
        ],
        edges: [],
      },
    };
    const payload = commandToJournalPayload(
      new SetGraphFunctionGraphsCommand(undefined, functionGraphs),
    );
    expect(payload.type).toBe("graph.setFunctionGraphs");
    const revived = reviveCommand(payload);
    expect(revived).toBeInstanceOf(SetGraphFunctionGraphsCommand);
    const next = revived!.apply({ nodes: [], edges: [] }) as {
      functionGraphs?: typeof functionGraphs;
    };
    expect(next.functionGraphs).toEqual(functionGraphs);
  });

  it("round-trips every scene command type through the journal", () => {
    const scene = createDefaultScene();
    const actorId = scene.actors[0]!.id;
    const componentId = scene.actors[0]!.components[0]!.id;
    const commands = [
      new AddActorCommand(createActor("added", "Added"), 1),
      new RemoveActorCommand(scene.actors[0]!, 0),
      new SetActorTransformCommand(
        actorId,
        scene.actors[0]!.transform,
        { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      ),
      new RenameActorCommand(actorId, "Cube", "Renamed"),
      new ReparentActorCommand(actorId, null, null),
      new ReorderActorCommand(actorId, 0, 0),
      new SetActorFlagsCommand(
        actorId,
        { visible: true, locked: false },
        { visible: false, locked: true },
      ),
      new AddComponentCommand(actorId, createMeshComponent("c9", "sphere")),
      new RemoveComponentCommand(
        actorId,
        scene.actors[0]!.components[0]!,
        0,
      ),
      new ReorderComponentCommand(actorId, componentId, 0, 0),
      new ReparentComponentCommand(actorId, componentId, null, null),
      new SetComponentPropertyCommand(
        actorId,
        componentId,
        "meshKind",
        "box",
        "sphere",
      ),
      new SetSceneSettingCommand("fogEnabled", false, true),
      new SetViewportModeCommand("3d", "2d"),
      new SetSceneNameCommand("Main", "Level 1"),
    ];

    for (const command of commands) {
      const payload = commandToJournalPayload(command);
      const revived = reviveCommand(payload);
      expect(revived, `no reviver for ${command.type}`).not.toBeNull();
      expect(revived!.type).toBe(command.type);
      expect(revived!.apply(createDefaultScene())).toEqual(
        command.apply(createDefaultScene()),
      );
    }
  });

  it("round-trips asset document merge keys", () => {
    const command = new SetAssetDocumentCommand(
      { n: 1 },
      { n: 2 },
      "tilemap-stroke:abc",
    );
    const payload = commandToJournalPayload(command);
    expect(payload.mergeKey).toBe("tilemap-stroke:abc");
    const revived = reviveCommand(payload) as SetAssetDocumentCommand | null;
    expect(revived).toBeInstanceOf(SetAssetDocumentCommand);
    expect(revived!.mergeKey).toBe("tilemap-stroke:abc");
    expect(revived!.apply({ n: 1 })).toEqual({ n: 2 });
  });
});
