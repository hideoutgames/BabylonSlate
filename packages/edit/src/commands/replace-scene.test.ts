import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createMeshComponent } from "@babylonslate/core";
import { EditSession } from "../session";
import { commandToJournalPayload, serializeJournalLine } from "../journal";
import { replayJournalLines } from "../journal-replay";
import { RenameActorCommand } from "./scene";
import { ReplaceSceneCommand } from "./replace-scene";

function fixture() {
  const before = createDefaultScene();
  before.name = "Starting 世界";
  before.actors = [createActor("parent", "Parent"), createActor("deleted", "Deleted")];
  before.folders = [{ id: "folder", name: "Folder", parentFolderId: null }];
  before.actors[0]!.folderId = "folder";
  before.actors[0]!.properties = { nullable: null, nested: { labels: ["原", "🙂"] } };
  before.actors[0]!.components = [{ ...createMeshComponent("mesh"), sourceId: "prefab", overrideKeys: ["materialGuid"] }];
  const after = structuredClone(before);
  after.name = "Final";
  after.actors = [createActor("spawned", "Spawned"), after.actors[0]!];
  after.actors[1]!.parentId = "spawned";
  after.actors[1]!.properties = { reference: { kind: "actorRef", actorId: "spawned" }, nested: { labels: [] } };
  after.actors[1]!.components = [{ ...createMeshComponent("replacement", "sphere"), properties: { materialGuid: "surface", parameters: { tint: { kind: "color", value: [1, 0, 0, 1] } } } }];
  after.actors[1]!.transform.position = [1, 2, 3];
  after.settings.fogEnabled = true;
  after.settings.postProcessStack = [{ id: "post", enabled: true, materialGuid: "post-material", parameters: { amount: { kind: "float", value: 0.5 } } }];
  return { before, after };
}

describe("ReplaceSceneCommand", () => {
  it("keeps complete scenes and their journal replay together in one reversible document step", () => {
    const { before, after } = fixture();
    const session = new EditSession();
    const original = structuredClone(before);
    original.actors[0]!.name = "Earlier";
    session.apply("scene", original, new RenameActorCommand("parent", "Earlier", "Parent"));
    const command = new ReplaceSceneCommand(before, after);
    const applied = session.applyWithHistoryAdmission("scene", before, command);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("Expected admission");
    expect(applied.doc).toStrictEqual(after);
    expect(session.getStack("scene").undoDepth).toBe(2);
    const undo = session.undo("scene", applied.doc)!;
    expect(undo.doc).toStrictEqual(before);
    const redo = session.redo("scene", undo.doc)!;
    expect(redo.doc).toStrictEqual(after);
    expect(session.undo("scene", redo.doc)?.doc).toStrictEqual(before);
    expect(session.undo("scene", before)?.doc).toStrictEqual(original);

    const lines = [command, undo.command, redo.command].map((entry) => serializeJournalLine({
      v: 1, docId: "scene", at: "2026-10-07T00:00:00Z", command: commandToJournalPayload(entry),
    }));
    for (const [count, expected] of [[1, after], [2, before], [3, after]] as const) {
      const replay = replayJournalLines(lines.slice(0, count), new Map([["scene", before]]));
      expect(replay.skipped).toEqual([]);
      expect(replay.documents.get("scene")).toStrictEqual(expected);
    }
  });

  it("uses UTF-8 snapshot costs for admission and protects snapshots from later caller edits", () => {
    const { before, after } = fixture();
    const expectedBefore = structuredClone(before), expectedAfter = structuredClone(after);
    const command = new ReplaceSceneCommand(before, after);
    const bytes = Buffer.byteLength(JSON.stringify(before), "utf8") + Buffer.byteLength(JSON.stringify(after), "utf8");
    expect(command.byteSize).toBe(bytes);
    expect(command.invert().byteSize).toBe(bytes);
    const session = new EditSession({ maxBytes: bytes * 2 - 1 });
    expect(session.applyWithHistoryAdmission("scene", before, command)).toMatchObject({ ok: false, reason: "history-budget", requiredBytes: bytes * 2 });
    expect(session.canUndo("scene")).toBe(false);
    before.actors.length = 0;
    after.actors.length = 0;
    const applied = command.apply(before);
    expect(applied).toStrictEqual(expectedAfter);
    applied.actors.length = 0;
    expect(command.apply(before)).toStrictEqual(expectedAfter);
    expect(command.invert().apply(applied)).toStrictEqual(expectedBefore);
  });

  it("adds no history for equal scenes and preserves the existing redo", () => {
    const { before, after } = fixture();
    const session = new EditSession();
    const first = session.apply("scene", before, new ReplaceSceneCommand(before, after));
    const undo = session.undo("scene", first.doc)!;
    const same = session.applyWithHistoryAdmission("scene", undo.doc, new ReplaceSceneCommand(undo.doc, structuredClone(undo.doc)));
    expect(same).toMatchObject({ ok: true, status: "unchanged" });
    expect(session.getStack("scene").undoDepth).toBe(0);
    expect(session.redo("scene", undo.doc)?.doc).toStrictEqual(after);
  });

  it.each([undefined, NaN, Infinity, -0, new Map([["key", 1]]), () => 1])("rejects noncanonical property values without silently losing them: %s", (value) => {
    const { before, after } = fixture();
    after.actors[0]!.properties = { unsupported: value };
    expect(() => new ReplaceSceneCommand(before, after)).toThrow(/Scene transaction/);
  });
});
