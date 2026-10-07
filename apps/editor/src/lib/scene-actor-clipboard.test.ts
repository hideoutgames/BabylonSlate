import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { copySceneActors, pasteSceneActors } from "./scene-actor-clipboard";
import { EditorSessionState } from "./editor-session-state";

describe("actor clipboard", () => {
  it("copies subtrees between scenes with new identities and internal references", () => {
    const source = createDefaultScene();
    source.actors = [
      createActor("actor-1", "Parent", { folderId: "source-folder" }),
      createActor("actor-2", "Child", { parentId: "actor-1", components: [
        { id: "cable", classId: "CableComponent", properties: { targetActorId: "actor-1", targetComponentId: null } },
        { id: "constraint", classId: "PhysicsConstraintComponent", properties: { targetActorId: "outside" } },
      ] }),
      createActor("outside", "Outside"),
    ];
    const store = new EditorSessionState();
    store.copyActors(copySceneActors(source, ["actor-1"]), false);
    source.actors[0]!.name = "Changed Later";
    const destination = createDefaultScene();
    destination.actors = [createActor("actor-1", "Destination"), createActor("actor-2", "Existing")];
    const copies = pasteSceneActors(destination, store.readCopiedActors(false));
    const [parent, child] = copies;
    expect(copies).toHaveLength(2);
    expect(new Set([...destination.actors, ...copies].map((actor) => actor.id)).size).toBe(4);
    expect(parent).toMatchObject({ name: "Parent Copy", parentId: null, folderId: null });
    expect(child).toMatchObject({ parentId: parent!.id, folderId: null });
    expect(child!.components[0]!.properties.targetActorId).toBe(parent!.id);
    expect(child!.components[1]!.properties.targetActorId).toBeNull();
    expect(store.readCopiedActors(true)).toEqual([]);
    expect(new EditorSessionState().readCopiedActors(false)).toEqual([]);
    // Pasting never consumes or edits the snapshot.
    const repeated = pasteSceneActors({ ...destination, actors: [...destination.actors, ...copies] }, store.readCopiedActors(false));
    expect(repeated[0]!.name).toBe("Parent Copy 2");
    expect(repeated[1]!.parentId).toBe(repeated[0]!.id);
  });
});
